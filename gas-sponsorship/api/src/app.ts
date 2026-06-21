import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { timing, startTime, endTime } from 'hono/timing'
import { env } from 'hono/adapter'
import { upgradeWebSocket } from 'hono/cloudflare-workers'
import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { fromBase64, isValidSuiAddress } from '@mysten/sui/utils'
import pRetry from 'p-retry'
import { loadPolicies, validateSponsoredTxPayload } from './policy'
import { executeTransaction, type OnStatus, type SponsorEvent } from './execution'
import { writeAnalytics } from './analytics'
import autoSwapApp from './autoSwap'
import receiveAndDepositApp from './receiveAndDeposit'
import receiveFromAccumulatorApp from './receiveFromAccumulator'
import receiveFromAccumulatorToOwnerApp from './receiveFromAccumulatorToOwner'
import walletSweepApp from './walletSweep'
import selfFundApp from './selfFund'
import sponsorPoliciesConfig, { resolveSponsorPolicies } from '../policies'

interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    indexes?: string[]
    blobs?: string[]
    doubles?: number[]
  }): void
}

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
  // Canonical Talise Move package id. Used to compile the sponsor
  // policy `targets` at request time so the sponsor only signs for
  // our own modules (send/vault/auto_swap/receipt). Unset = sponsor
  // refuses every Talise tx (safer than falling back to wildcard).
  TALISE_PACKAGE_ID?: string
  DRY_RUN_ONLY?: string
  EXECUTION_TIMEOUT_MS?: string
  CONFIRMATION_TIMEOUT_MS?: string
  ANALYTICS?: AnalyticsEngineDataset
  HAYABUSA?: { fetch: typeof fetch }
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 45_000
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000
const MAX_CALLER_TIMEOUT_MS = 60_000

const app = new Hono()

app.use(cors())
app.use(timing())
app.use(async (c, next) => {
  const { HAYABUSA } = env<Bindings>(c)
  c.header('x-onara-transport', HAYABUSA ? 'hayabusa' : 'direct')
  await next()
})

// Global variable cache — persists across requests within the same Worker instance.
// Cloudflare Workers run one instance per edge node; global state survives between
// invocations but is lost on eviction. We key by config to handle redeployments
// that change env vars.
let _grpcClient: SuiGrpcClient | null = null
let _grpcClientKey = ''

const getGrpcClient = (network: string, baseUrl: string, serviceBinding?: { fetch: typeof fetch }): SuiGrpcClient => {
  const key = serviceBinding ? `${network}:binding` : `${network}:${baseUrl}`
  if (_grpcClient && _grpcClientKey === key) return _grpcClient
  _grpcClient = serviceBinding
    ? new SuiGrpcClient({ network, baseUrl, fetch: ((input, init) => serviceBinding.fetch(input, init)) as typeof fetch })
    : new SuiGrpcClient({ network, baseUrl })
  _grpcClientKey = key
  return _grpcClient
}

// Wraps a hayabusa service binding's fetch to capture the responding backend hash
// and inject it as x-hayabusa-prefer-backend on subsequent calls. Scoped per
// instance — create one per request so concurrent handlers don't share state.
const createPinningFetch = (serviceBinding: { fetch: typeof fetch }): typeof fetch => {
  let preferredBackend: string | null = null
  return (async (input, init) => {
    const headers = new Headers(init?.headers)
    if (preferredBackend) headers.set('x-hayabusa-prefer-backend', preferredBackend)
    const res = await serviceBinding.fetch(input, { ...init, headers })
    const backend = res.headers.get('x-hayabusa-backend')
    if (backend) preferredBackend = backend
    return res
  }) as typeof fetch
}

let _keypair: Ed25519Keypair | null = null
let _keypairKey = ''
let _sponsorAddress = ''

const getKeyPair = (mnemonic: string): Ed25519Keypair => {
  if (_keypair && _keypairKey === mnemonic) return _keypair
  _keypair = Ed25519Keypair.deriveKeypair(mnemonic)
  _keypairKey = mnemonic
  _sponsorAddress = _keypair.toSuiAddress()
  return _keypair
}

const getSponsorAddress = (mnemonic: string): string => {
  if (_sponsorAddress && _keypairKey === mnemonic) return _sponsorAddress
  getKeyPair(mnemonic)
  return _sponsorAddress
}

/**
 * Extract a human-readable reason from a gRPC FailedTransaction. The reason
 * lives at effects.status.error (newer) or status.error (older), and can be a
 * plain string OR a structured object (MoveAbort, InsufficientGas, etc.) — the
 * structured case is what was surfacing to clients as "[object Object]". Prefer
 * description/message, else JSON-stringify so the real cause is never hidden.
 */
function describeSimError(failed: unknown): string {
  const f = failed as { effects?: { status?: unknown }; status?: unknown }
  const status = (f?.effects?.status ?? f?.status) as
    | { error?: unknown }
    | string
    | undefined
  const err = status && typeof status === 'object' ? status.error : status
  if (err == null) return 'unknown error'
  if (typeof err === 'string') return err
  const e = err as { description?: string; message?: string }
  return e.description ?? e.message ?? JSON.stringify(err)
}

const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/
const base64Field = z
  .string()
  .trim()
  .min(1, 'Missing base64 payload.')
  .regex(base64Regex, 'Invalid base64 payload.')

const sponsorPayloadSchema = z.object({
  sender: z.string().refine(isValidSuiAddress, 'Invalid Sui address.'),
  txBytes: base64Field,
  txSignature: base64Field,
})

// Per-binding cache so we don't re-compile policies on every request.
// Keyed by the resolved package id (empty string = no Talise package).
const _policiesCache = new Map<string, ReturnType<typeof loadPolicies>>()

function getSponsorPolicies(bindings: Bindings) {
  const key = (bindings.TALISE_PACKAGE_ID ?? '').trim()
  const cached = _policiesCache.get(key)
  if (cached) return cached
  const raw = resolveSponsorPolicies(key)
  if (raw.length === 0) {
    throw new Error('TALISE_PACKAGE_ID binding is unset; sponsor refuses to sign without a canonical Move package id.')
  }
  const compiled = loadPolicies(raw)
  _policiesCache.set(key, compiled)
  return compiled
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveExecutionTimeout(bindings: Bindings, callerValue?: string): number {
  const serverMax = bindings.EXECUTION_TIMEOUT_MS ? Number(bindings.EXECUTION_TIMEOUT_MS) : DEFAULT_EXECUTION_TIMEOUT_MS
  const caller = callerValue ? Number(callerValue) : undefined
  return caller && caller > 0 && caller <= MAX_CALLER_TIMEOUT_MS ? Math.min(caller, serverMax) : serverMax
}

function resolveConfirmationTimeout(bindings: Bindings, callerValue?: string): number {
  const serverMax = bindings.CONFIRMATION_TIMEOUT_MS ? Number(bindings.CONFIRMATION_TIMEOUT_MS) : DEFAULT_CONFIRMATION_TIMEOUT_MS
  const caller = callerValue ? Number(callerValue) : undefined
  return caller && caller > 0 && caller <= MAX_CALLER_TIMEOUT_MS ? Math.min(caller, serverMax) : serverMax
}

function createGrpcClient(bindings: Bindings): SuiGrpcClient {
  return bindings.HAYABUSA
    ? new SuiGrpcClient({ network: bindings.SUI_NETWORK, baseUrl: bindings.SUI_GRPC_URL, fetch: createPinningFetch(bindings.HAYABUSA) })
    : getGrpcClient(bindings.SUI_NETWORK, bindings.SUI_GRPC_URL)
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/status', async (c) => {
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC, HAYABUSA } = env<Bindings>(c)

  startTime(c, 'init', 'Client & keypair init')
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL, HAYABUSA)
  const address = getSponsorAddress(SUI_MNEMONIC)
  endTime(c, 'init')

  let chainId: string | null = null
  let balances: { active: string; pending: string } | null = null
  try {
    startTime(c, 'rpc', 'Chain ID & balance fetch')
    const [chainResult, balanceResult] = await Promise.all([
      grpcClient.core.getChainIdentifier(),
      grpcClient.getBalance({ owner: address }),
    ])
    endTime(c, 'rpc')
    chainId = chainResult.chainIdentifier
    balances = {
      active: balanceResult.balance.addressBalance,
      pending: balanceResult.balance.coinBalance,
    }
  } catch {}
  return c.json({
    network: SUI_NETWORK,
    chainId,
    address,
    balances,
    transport: HAYABUSA ? 'hayabusa' : 'direct',
  })
})

app.get('/policies', (c) => {
  return c.json(sponsorPoliciesConfig)
})

// ─── Auto-swap (Path C executor) ──────────────────────────────────────────────
app.route('/auto-swap', autoSwapApp)

// ─── Receive-and-deposit (claims address-owned coins into a vault) ───────────
// Pairs with `vault::receive_and_deposit<T>` (package v2). The auto-swap
// cron calls this to fold orphan `Coin<T>` sent to a vault's address
// into the vault's balance bag before sweeping.
app.route('/receive-and-deposit', receiveAndDepositApp)

// v5+ companion: claim from Sui's address-accumulator. On current
// mainnet the accumulator is the dominant path for transfer-to-shared-
// object-address, so this is what the cron uses for fresh deposits.
app.route('/receive-from-accumulator', receiveFromAccumulatorApp)

// v6+ companion: same accumulator claim, but routes the proceeds
// straight to `vault.owner` instead of folding into the bag. Used by
// the cron for the USDsui (dest type) direct-to-wallet path.
app.route('/receive-from-accumulator-to-owner', receiveFromAccumulatorToOwnerApp)

// Wallet sweep: builds a single PTB that converts every non-USDsui coin
// in the owner's plain wallet into USDsui via the Cetus aggregator. The
// owner signs (zkLogin), Onara provides gas via /sponsor. See
// walletSweep.ts for the per-leg Cetus aggregator integration.
app.route('/wallet-sweep', walletSweepApp)

// Admin self-fund: sponsor sweeps its OWN plain Coin<SUI> into its OWN address-
// balance accumulator (coin::send_funds), turning `pending` into `active` gas.
// Fixes "funded but 0 active" when SUI was sent as a plain transfer. Guarded by
// the ADMIN_TOKEN secret (x-admin-token header). See selfFund.ts.
app.route('/admin/self-fund', selfFundApp)

// ─── Transaction status lookup ────────────────────────────────────────────────

app.get('/sponsor/:digest/status', async (c) => {
  const bindings = env<Bindings>(c)
  const digest = c.req.param('digest')
  const grpcClient = getGrpcClient(bindings.SUI_NETWORK, bindings.SUI_GRPC_URL, bindings.HAYABUSA)

  try {
    const tx = await grpcClient.getTransaction({ digest, include: { effects: true } })
    return c.json({ found: true, ...tx })
  } catch {
    return c.json({ found: false, digest }, 404)
  }
})

// ─── HTTP sponsorship ─────────────────────────────────────────────────────────

app.post('/sponsor', async (c) => {
  const bindings = env<Bindings>(c)
  const { DRY_RUN_ONLY, ANALYTICS, SUI_GRPC_URL } = bindings
  const parseBool = (v: string | undefined) => v === 'true' || v === '1'
  const waitForExecution = c.req.query('waitForExecution') !== 'false'
  const simulate = c.req.query('simulate') !== 'false'
  const dryRun = !!DRY_RUN_ONLY || parseBool(c.req.query('dryRun'))
  const executionTimeoutMs = resolveExecutionTimeout(bindings, c.req.query('executionTimeoutMs') ?? undefined)
  const confirmationTimeoutMs = resolveConfirmationTimeout(bindings, c.req.query('confirmationTimeoutMs') ?? undefined)

  const payload = (await c.req.json()) as {
    sender?: string
    txBytes?: string
    txSignature?: string
  }

  const parsed = sponsorPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? 'Invalid request payload.'
    return c.json({ error: issue }, 400)
  }

  startTime(c, 'init', 'Client & keypair init')
  // Fresh client per request when hayabusa is bound — pinning fetch holds per-request
  // state to route follow-up reads to the same backend that saw the first response.
  const grpcClient = createGrpcClient(bindings)
  const keypair = getKeyPair(bindings.SUI_MNEMONIC)
  const sponsorAddress = getSponsorAddress(bindings.SUI_MNEMONIC)
  endTime(c, 'init')

  // Compile policies bound to the canonical Talise package id from
  // request bindings. Throws if the env var is unset (we refuse to
  // sign without a canonical package id).
  let sponsorPolicies: ReturnType<typeof loadPolicies>
  try {
    sponsorPolicies = getSponsorPolicies(bindings)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Policy resolution failed.'
    return c.json({ error: message }, 500)
  }

  // Resolve SuiNS name only when a policy requires it
  startTime(c, 'suins', 'SuiNS resolution')
  const senderName = sponsorPolicies.needsSuinsResolution
    ? (await pRetry(
        () => grpcClient.core.defaultNameServiceName({ address: parsed.data.sender }),
        { retries: 1 },
      )).data.name
    : null
  endTime(c, 'suins')

  startTime(c, 'validate', 'Policy validation')
  let calledTargets: string[] = []
  let matchedPolicyName = ''
  try {
    const validation = validateSponsoredTxPayload({
      txBytesBase64: parsed.data.txBytes,
      expectedSender: parsed.data.sender,
      expectedSponsor: sponsorAddress,
      policies: sponsorPolicies,
      senderName,
    })
    calledTargets = validation.calledTargets
    matchedPolicyName = validation.matchedPolicyName
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to validate sponsored transaction.'
    return c.json({ error: message }, 400)
  }
  endTime(c, 'validate')

  console.log(
    JSON.stringify({
      message: 'Sponsor request validated.',
      sender: parsed.data.sender,
      sponsor: sponsorAddress,
      policy: matchedPolicyName,
      moveCallTargets: calledTargets,
    }),
  )

  if (dryRun) {
    return c.json({ dryRun: true, policy: matchedPolicyName, moveCallTargets: calledTargets })
  }

  const txBytes = fromBase64(parsed.data.txBytes)

  // Parse transaction locally for analytics (gas budget, move call count)
  const txData = Transaction.from(parsed.data.txBytes).getData()
  const gasBudget = Number(txData.gasData.budget ?? 0)
  const numMoveCalls = txData.commands.filter((cmd) => cmd.$kind === 'MoveCall').length

  // Cloudflare request metadata
  const cf = (c.req.raw as unknown as { cf?: Record<string, string> }).cf
  const rpcNode = SUI_GRPC_URL
  const userAgent = c.req.header('user-agent') ?? ''
  const ip = c.req.header('cf-connecting-ip') ?? ''
  const ipHash = ip
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))))
        .map(b => b.toString(16).padStart(2, '0')).join('')
    : ''

  if (simulate) {
    try {
      startTime(c, 'simulate', 'Transaction simulation')
      const simulation = await pRetry(
        () => grpcClient.simulateTransaction({ transaction: txBytes }),
        { retries: 1 },
      )
      endTime(c, 'simulate')
      if (simulation.$kind === 'FailedTransaction') {
        const reason = describeSimError(simulation.FailedTransaction)
        console.error(JSON.stringify({ message: 'Simulation failed', sender: parsed.data.sender, policy: matchedPolicyName, reason, raw: simulation.FailedTransaction }))
        return c.json({ error: `Simulation failed: ${reason}` }, 400)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simulation failed.'
      return c.json({ error: decodeURIComponent(message) }, 400)
    }
  }

  startTime(c, 'execute', 'Sign & execute transaction')
  const outcome = await executeTransaction({
    grpcClient,
    keypair,
    txBytes,
    txSignature: parsed.data.txSignature,
    waitForExecution,
    executionTimeoutMs,
    confirmationTimeoutMs,
  })
  endTime(c, 'execute')

  const analyticsBase = {
    dataset: ANALYTICS,
    sender: parsed.data.sender,
    policyName: matchedPolicyName,
    rpcNode,
    cf,
    userAgent,
    ipHash,
    gasBudget,
    numMoveCalls,
  }

  switch (outcome.kind) {
    case 'success': {
      const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
      writeAnalytics({
        ...analyticsBase,
        epoch: tx?.epoch ?? '',
        digest: tx?.digest ?? '',
        success: outcome.result.$kind === 'Transaction',
        durationMs: outcome.durationMs,
        gasUsed: tx?.effects?.gasUsed,
      })
      return c.json(outcome.result)
    }

    case 'confirmation_timeout': {
      const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
      writeAnalytics({
        ...analyticsBase,
        epoch: tx?.epoch ?? '',
        digest: outcome.digest,
        success: false,
        durationMs: outcome.durationMs,
        gasUsed: tx?.effects?.gasUsed,
      })
      return c.json({ error: outcome.error, digest: outcome.digest, status: 'unconfirmed' as const }, 504)
    }

    case 'execution_timeout':
    case 'execution_error': {
      writeAnalytics({
        ...analyticsBase,
        epoch: '',
        digest: '',
        success: false,
        durationMs: outcome.durationMs,
        gasUsed: undefined,
      })
      const httpStatus = outcome.kind === 'execution_timeout' ? 504 : 500
      return c.json({ error: outcome.error, status: 'unknown' as const }, httpStatus)
    }
  }
})

// ─── WebSocket sponsorship ────────────────────────────────────────────────────

app.get(
  '/sponsor/ws',
  upgradeWebSocket((c) => {
    const bindings = env<Bindings>(c)

    return {
      onMessage: async (evt, ws) => {
        const send = (event: SponsorEvent) => ws.send(JSON.stringify(event))

        let payload: unknown
        try {
          payload = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer))
        } catch {
          send({ status: 'error', error: 'Invalid JSON.' })
          ws.close(1008)
          return
        }

        send({ status: 'received' })

        const parsed = sponsorPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          send({ status: 'error', error: parsed.error.issues[0]?.message ?? 'Invalid request payload.' })
          ws.close(1008)
          return
        }

        const wsPayload = payload as Record<string, unknown>
        const simulate = wsPayload.simulate !== false
        const waitForExecution = wsPayload.waitForExecution !== false
        const executionTimeoutMs = resolveExecutionTimeout(bindings)
        const confirmationTimeoutMs = resolveConfirmationTimeout(bindings)

        const grpcClient = createGrpcClient(bindings)
        const keypair = getKeyPair(bindings.SUI_MNEMONIC)
        const sponsorAddress = getSponsorAddress(bindings.SUI_MNEMONIC)

        // Compile policies bound to the request's package id.
        let sponsorPolicies: ReturnType<typeof loadPolicies>
        try {
          sponsorPolicies = getSponsorPolicies(bindings)
        } catch (error) {
          send({ status: 'error', error: error instanceof Error ? error.message : 'Policy resolution failed.' })
          ws.close(1011)
          return
        }

        // SuiNS resolution
        let senderName: string | null = null
        if (sponsorPolicies.needsSuinsResolution) {
          try {
            senderName = (await pRetry(
              () => grpcClient.core.defaultNameServiceName({ address: parsed.data.sender }),
              { retries: 1 },
            )).data.name
          } catch (error) {
            send({ status: 'error', error: 'SuiNS resolution failed.' })
            ws.close(1011)
            return
          }
        }

        // Policy validation
        send({ status: 'validating' })
        let matchedPolicyName = ''
        try {
          const validation = validateSponsoredTxPayload({
            txBytesBase64: parsed.data.txBytes,
            expectedSender: parsed.data.sender,
            expectedSponsor: sponsorAddress,
            policies: sponsorPolicies,
            senderName,
          })
          matchedPolicyName = validation.matchedPolicyName
        } catch (error) {
          send({ status: 'error', error: error instanceof Error ? error.message : 'Policy validation failed.' })
          ws.close(1008)
          return
        }

        const txBytes = fromBase64(parsed.data.txBytes)

        // Simulation
        if (simulate) {
          send({ status: 'simulating' })
          try {
            const simulation = await pRetry(
              () => grpcClient.simulateTransaction({ transaction: txBytes }),
              { retries: 1 },
            )
            if (simulation.$kind === 'FailedTransaction') {
              const reason = describeSimError(simulation.FailedTransaction)
              console.error(JSON.stringify({ message: 'Simulation failed (ws)', reason, raw: simulation.FailedTransaction }))
              send({ status: 'error', error: `Simulation failed: ${reason}` })
              ws.close(1008)
              return
            }
          } catch (error) {
            send({ status: 'error', error: error instanceof Error ? error.message : 'Simulation failed.' })
            ws.close(1011)
            return
          }
        }

        // Analytics prep
        const txData = Transaction.from(parsed.data.txBytes).getData()
        const gasBudget = Number(txData.gasData.budget ?? 0)
        const numMoveCalls = txData.commands.filter((cmd) => cmd.$kind === 'MoveCall').length

        // Execution with status callbacks
        const outcome = await executeTransaction({
          grpcClient,
          keypair,
          txBytes,
          txSignature: parsed.data.txSignature,
          waitForExecution,
          executionTimeoutMs,
          confirmationTimeoutMs,
          onStatus: send,
        })

        const analyticsBase = {
          dataset: bindings.ANALYTICS,
          sender: parsed.data.sender,
          policyName: matchedPolicyName,
          rpcNode: bindings.SUI_GRPC_URL,
          cf: undefined,
          userAgent: '',
          ipHash: '',
          gasBudget,
          numMoveCalls,
        }

        switch (outcome.kind) {
          case 'success': {
            const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
            writeAnalytics({
              ...analyticsBase,
              epoch: tx?.epoch ?? '',
              digest: tx?.digest ?? '',
              success: outcome.result.$kind === 'Transaction',
              durationMs: outcome.durationMs,
              gasUsed: tx?.effects?.gasUsed,
            })
            // confirmed event already sent by executeTransaction via onStatus
            break
          }
          case 'confirmation_timeout': {
            const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
            writeAnalytics({
              ...analyticsBase,
              epoch: tx?.epoch ?? '',
              digest: outcome.digest,
              success: false,
              durationMs: outcome.durationMs,
              gasUsed: tx?.effects?.gasUsed,
            })
            send({ status: 'error', error: outcome.error, digest: outcome.digest })
            break
          }
          case 'execution_timeout':
          case 'execution_error': {
            writeAnalytics({
              ...analyticsBase,
              epoch: '',
              digest: '',
              success: false,
              durationMs: outcome.durationMs,
              gasUsed: undefined,
            })
            send({ status: 'error', error: outcome.error })
            break
          }
        }

        ws.close(1000)
      },

      onError: () => {},
    }
  }),
)

export default app
