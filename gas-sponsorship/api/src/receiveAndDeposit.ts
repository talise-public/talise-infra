// Onara receive-and-deposit executor.
//
// Coins sent to a user's `@talise` SuiNS subname resolve to the user's
// `TaliseVault` object address. Because the vault is a *shared* object,
// the resulting `Coin<T>` becomes "address-owned" by the vault id —
// it can't be spent through the normal owned-object pathway. The
// `vault::receive_and_deposit<T>` entry (added in package v2) consumes
// these orphans by way of `transfer::public_receive<Coin<T>>`, folding
// them into the vault's `balances` bag where the existing auto-swap
// flow can sweep them.
//
// This route is the worker-signed leg. The off-chain cron scans
// `suix_getOwnedObjects` against the vault's id, picks `Coin<T>` types
// that match the user's active `AutoSwapCap<T>` set, and POSTs each one
// here for execution. We sign as the Onara mnemonic — `receive_and_deposit`
// has no admin assertion (anyone can call it; the only destination is
// the vault's own bag), so this is purely a gas convenience.

import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from 'hono/adapter'
import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { isValidSuiObjectId } from '@mysten/sui/utils'
import pRetry from 'p-retry'
import pTimeout from 'p-timeout'

// ─── Env shape (subset — must match app.ts Bindings) ─────────────────────────

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
  EXECUTION_TIMEOUT_MS?: string
  HAYABUSA?: { fetch: typeof fetch }
}

// ─── Request validation ──────────────────────────────────────────────────────

// Mirrors the loose type-tag regex used by /auto-swap. The chain is the
// final arbiter; we just want to catch the obvious garbage upfront.
const moveTypeRegex =
  /^0x[0-9a-fA-F]{1,64}::[a-zA-Z_][a-zA-Z0-9_]*::[a-zA-Z_][a-zA-Z0-9_<>:,\s0-9a-fA-Fx]*$/

const objectIdField = z
  .string()
  .trim()
  .refine(isValidSuiObjectId, 'must be a 0x… Sui object id')

const bodySchema = z.object({
  vaultId: objectIdField,
  // The address-owned `Coin<T>` object id sitting under `vault.id`.
  coinObjectId: objectIdField,
  // u64 version + Base58 digest of the coin object. Required by
  // `tx.receivingRef` to construct the Receiving<Coin<T>> input — the
  // SDK can't auto-resolve these because the coin isn't owned by the
  // PTB signer.
  coinVersion: z.string().trim().regex(/^\d+$/, 'coinVersion must be u64 string'),
  coinDigest: z.string().trim().min(1),
  // Fully-qualified type-tag of `T` — the inner coin type, not the
  // wrapping `Coin<T>`. Plumbed verbatim into the Move call's type args.
  coinType: z
    .string()
    .trim()
    .min(5, 'coinType missing')
    .regex(moveTypeRegex, 'coinType is not a valid Move type tag'),
  packageId: objectIdField,
})

export type ReceiveAndDepositRequest = z.infer<typeof bodySchema>

// ─── PTB builder ─────────────────────────────────────────────────────────────

async function buildReceiveTx(
  req: ReceiveAndDepositRequest,
  sender: string,
  _grpc: SuiGrpcClient,
): Promise<Transaction> {
  // Re-fetch the coin's live (version, digest) directly via JSON-RPC
  // right before building. The cron's snapshot can lag the fullnode
  // that the actual broadcast hits, causing "Could not find the
  // referenced object at version SequenceNumber(X)". Going through
  // direct fetch avoids gRPC SDK shape mismatches.
  const rpcUrl = 'https://fullnode.mainnet.sui.io:443'
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sui_getObject',
      params: [req.coinObjectId, { showOwner: false }],
    }),
    signal: AbortSignal.timeout(6000),
  })
  if (!r.ok) {
    throw new Error(`getObject HTTP ${r.status}`)
  }
  const body = (await r.json()) as {
    result?: { data?: { version?: string; digest?: string } }
    error?: { message: string }
  }
  if (body.error) throw new Error(body.error.message)
  const ver = body.result?.data?.version
  const dig = body.result?.data?.digest
  if (!ver || !dig) {
    throw new Error(
      `coin ${req.coinObjectId} not found on Sui (already consumed?)`,
    )
  }

  const tx = new Transaction()
  tx.setSender(sender)
  tx.moveCall({
    target: `${req.packageId}::vault::receive_and_deposit`,
    typeArguments: [req.coinType],
    arguments: [
      tx.object(req.vaultId),
      tx.receivingRef({
        objectId: req.coinObjectId,
        version: ver,
        digest: dig,
      }),
    ],
  })
  return tx
}

// ─── Client / keypair helpers (mirroring autoSwap.ts) ────────────────────────

let _grpc: SuiGrpcClient | null = null
let _grpcKey = ''
function getGrpc(bindings: Bindings): SuiGrpcClient {
  if (bindings.HAYABUSA) {
    return new SuiGrpcClient({
      network: bindings.SUI_NETWORK,
      baseUrl: bindings.SUI_GRPC_URL,
      fetch: ((input, init) =>
        bindings.HAYABUSA!.fetch(input, init)) as typeof fetch,
    })
  }
  const key = `${bindings.SUI_NETWORK}:${bindings.SUI_GRPC_URL}`
  if (_grpc && _grpcKey === key) return _grpc
  _grpc = new SuiGrpcClient({
    network: bindings.SUI_NETWORK,
    baseUrl: bindings.SUI_GRPC_URL,
  })
  _grpcKey = key
  return _grpc
}

let _kp: Ed25519Keypair | null = null
let _kpMnemonic = ''
function getKeypair(mnemonic: string): Ed25519Keypair {
  if (_kp && _kpMnemonic === mnemonic) return _kp
  _kp = Ed25519Keypair.deriveKeypair(mnemonic)
  _kpMnemonic = mnemonic
  return _kp
}

// ─── Route ───────────────────────────────────────────────────────────────────

const DEFAULT_EXECUTION_TIMEOUT_MS = 45_000

async function handleReceiveAndDeposit(c: Context<{ Bindings: Bindings }>) {
  const bindings = env<Bindings>(c)

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Request body must be valid JSON.' }, 400)
  }

  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid request body.'
    return c.json({ ok: false, error: message }, 400)
  }
  const req = parsed.data

  const keypair = getKeypair(bindings.SUI_MNEMONIC)
  const sender = keypair.toSuiAddress()
  const grpc = getGrpc(bindings)

  // Build PTB
  let txBytes: Uint8Array
  try {
    const tx = await buildReceiveTx(req, sender, grpc)
    txBytes = await tx.build({ client: grpc })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to build receive-and-deposit transaction.'
    return c.json({ ok: false, error: `Build failed: ${message}` }, 500)
  }

  const executionTimeoutMs = bindings.EXECUTION_TIMEOUT_MS
    ? Number(bindings.EXECUTION_TIMEOUT_MS)
    : DEFAULT_EXECUTION_TIMEOUT_MS

  try {
    const result = await pTimeout(
      pRetry(
        () =>
          grpc.signAndExecuteTransaction({
            signer: keypair,
            transaction: txBytes,
            include: { effects: true },
          }),
        { retries: 1 },
      ),
      {
        milliseconds: executionTimeoutMs,
        message: 'receive-and-deposit execution timed out.',
      },
    )

    const tx =
      result.$kind === 'Transaction'
        ? result.Transaction
        : result.FailedTransaction
    const digest = tx?.digest ?? ''

    if (result.$kind === 'FailedTransaction') {
      const errMsg =
        result.FailedTransaction?.effects?.status?.error ??
        'Transaction failed.'
      return c.json(
        {
          ok: false,
          error: errMsg,
          digest,
          vaultId: req.vaultId,
          coinObjectId: req.coinObjectId,
          coinType: req.coinType,
        },
        500,
      )
    }

    return c.json({
      ok: true,
      digest,
      vaultId: req.vaultId,
      coinObjectId: req.coinObjectId,
      coinType: req.coinType,
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'receive-and-deposit execution failed.'
    return c.json(
      {
        ok: false,
        error: message,
        vaultId: req.vaultId,
        coinObjectId: req.coinObjectId,
        coinType: req.coinType,
      },
      500,
    )
  }
}

// ─── Hono sub-app ────────────────────────────────────────────────────────────

const receiveAndDeposit = new Hono<{ Bindings: Bindings }>()
receiveAndDeposit.use(cors())
receiveAndDeposit.post('/', handleReceiveAndDeposit)

export default receiveAndDeposit
export { handleReceiveAndDeposit, buildReceiveTx, bodySchema }
