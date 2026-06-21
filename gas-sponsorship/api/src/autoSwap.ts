// Onara auto-swap executor — Path C off-chain side.
//
// This route is the worker-signed leg of the auto-swap flow described
// in move/talise/AUTOSWAP.md. The handler builds and submits a PTB that
// atomically extracts `Balance<Source>` from a TaliseVault, swaps it on
// Cetus, and deposits the resulting `Balance<Dest>` back into the same
// vault. The Move side (`vault::auto_swap_extract` → `validate_for_swap`)
// asserts the signer is the registry admin — which is the same sponsor
// keypair derived from SUI_MNEMONIC, so signing with that keypair as
// sender (not as additional sponsor sig) is what unlocks the cap.
//
// The actual swap is performed via the Cetus aggregator SDK
// (`@cetusprotocol/aggregator-sdk`), which discovers the best-priced
// route across every DEX on Sui and returns a single PTB fragment that
// our PTB consumes. The aggregator's ESM bundle is Workers-safe — its
// only runtime deps are `@mysten/sui/*`, `@pythnetwork/hermes-client`
// (fetch-based), and `bn.js` (pure JS with a defensive try/catch around
// `require("buffer")`). The `nodejs_compat` flag in wrangler.jsonc
// makes the buffer require succeed deterministically.

import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from 'hono/adapter'
import { z } from 'zod'
import {
  Transaction,
  type TransactionObjectArgument,
} from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { isValidSuiObjectId } from '@mysten/sui/utils'
import { AggregatorClient } from '@cetusprotocol/aggregator-sdk'
import BN from 'bn.js'
import pRetry from 'p-retry'
import pTimeout from 'p-timeout'

// ─── Tunables ────────────────────────────────────────────────────────────────

/// Default slippage tolerance for the aggregator route (1.0%). The
/// aggregator SDK consumes this as a fractional ratio, so 0.01 means
/// "abort the swap if amountOut would dip more than 1% below the
/// quoted figure". Tighten for stablecoin↔stablecoin routes, loosen
/// for long-tail pairs — but never relax beyond 5% from this worker;
/// users opted in to "best execution," not "any execution."
const DEFAULT_SLIPPAGE = 0.01

/// Public Cetus aggregator endpoint — BASE URL only. The SDK appends
/// `/find_routes` and other path segments itself, so the previous value
/// `…/router_v2/find_routes` produced double-`/find_routes` URLs that
/// returned a v2-shaped response the SDK's `parseRouterResponse`
/// couldn't decode (it reads `data.paths` but v2 returns
/// `data.routes[].path`). Crashed deep in the SDK with
/// "Cannot read properties of undefined (reading 'map')". v3 is what
/// `DEFAULT_AGG_V3_ENDPOINT` inside the SDK uses too.
const CETUS_AGGREGATOR_ENDPOINT = 'https://api-sui.cetus.zone/router_v3'

/// Talise swap fee — 1% of every auto-swap is skimmed to the treasury via
/// the Cetus aggregator's NATIVE overlay fee. Keep in sync with
/// `SWAP_FEE_BPS` in web/app/api/swap/prepare/route.ts + walletSweep.ts.
const SWAP_FEE_RATE = 0.01
const TREASURY_WALLET =
  '0xc0bf1c51e44f8cfa4a06f16a2408effa3507ac4582744c7ead56078b5e251a48'

// ─── Env shape (subset — must match app.ts Bindings) ─────────────────────────

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
  EXECUTION_TIMEOUT_MS?: string
  HAYABUSA?: { fetch: typeof fetch }
}

// ─── Request validation ──────────────────────────────────────────────────────

// Sui Move type tag — roughly `0x<hex>::module::Name` optionally with
// generic params. We deliberately keep this loose; the chain is the
// final arbiter of well-formedness.
const moveTypeRegex =
  /^0x[0-9a-fA-F]{1,64}::[a-zA-Z_][a-zA-Z0-9_]*::[a-zA-Z_][a-zA-Z0-9_<>:,\s0-9a-fA-Fx]*$/

const u64String = z
  .string()
  .trim()
  .regex(/^\d+$/, 'amount must be a u64 decimal string')
  .refine((s) => {
    try {
      const v = BigInt(s)
      return v > 0n && v <= 18446744073709551615n
    } catch {
      return false
    }
  }, 'amount must fit in u64 and be > 0')

const objectIdField = z
  .string()
  .trim()
  .refine(isValidSuiObjectId, 'must be a 0x… Sui object id')

const autoSwapBodySchema = z.object({
  vaultId: objectIdField,
  capId: objectIdField,
  sourceType: z
    .string()
    .trim()
    .min(5, 'sourceType missing')
    .regex(moveTypeRegex, 'sourceType is not a valid Move type tag'),
  destType: z
    .string()
    .trim()
    .min(5, 'destType missing')
    .regex(moveTypeRegex, 'destType is not a valid Move type tag'),
  amount: u64String,
  packageId: objectIdField,
  /// Latest package id (post-upgrade). Required for entry functions
  /// that only exist in newer versions — e.g. `vault::auto_swap_deposit_to_owner`
  /// shipped in v4. Falls back to `packageId` so single-version
  /// callers still build a PTB that dispatches into whatever the
  /// `packageId` value resolves to on chain.
  packageIdLatest: objectIdField.optional(),
  registryId: objectIdField,
  /// v7 hardened registry (`AutoSwapRegistryV2`). Required when
  /// `capVersion === "v2"` because the v2 Move entries take
  /// `&mut AutoSwapRegistryV2` as an additional argument that carries
  /// the pause flag, dest allowlist, worker membership, and per-cap
  /// throttle bookkeeping. Ignored on the v1 path.
  registryV2Id: objectIdField.optional(),
  /// Selects which Move target the PTB dispatches into:
  ///   "v1" → `vault::auto_swap_extract` + `vault::auto_swap_deposit_to_owner`
  ///   "v2" → `vault::auto_swap_extract_v2` + `vault::auto_swap_deposit_to_owner_v2`
  /// Defaults to "v1" for back-compat with any caller that hasn't been
  /// updated. The cron worker explicitly sends "v2" for every v7 cap.
  capVersion: z.enum(['v1', 'v2']).default('v1'),
  pool: objectIdField.optional(),
})

export type AutoSwapRequest = z.infer<typeof autoSwapBodySchema>

// ─── Cetus aggregator swap ───────────────────────────────────────────────────

/// Wraps a `Balance<Source>` from `vault::auto_swap_extract` in a
/// `Coin<Source>`, routes it through the Cetus aggregator, and unwraps
/// the resulting `Coin<Dest>` back into a `Balance<Dest>` that
/// `vault::auto_swap_deposit` can consume.
///
/// The aggregator expects a Coin (not a Balance), which is why the
/// `coin::from_balance` / `coin::into_balance` shims sandwich the
/// `routerSwap` call. These are stdlib at `0x2::coin` and add a single
/// moveCall on each side — cheap enough that we do not bother with a
/// fast-path when source==dest (the chain accepts a no-op route, and a
/// `Coin<T> → Balance<T>` round trip is fine).
///
/// `pool` is honored as a routing bias: when supplied, the aggregator
/// is asked to restrict its search to that pool's provider. If the
/// caller passes an unknown pool we fall back to unconstrained routing
/// rather than fail the request — that way an out-of-date hint never
/// blocks a swap.
async function cetusSwap(
  tx: Transaction,
  sourceBalance: TransactionObjectArgument,
  sourceType: string,
  destType: string,
  pool: string | undefined,
  amount: string,
  aggregator: AggregatorClient,
): Promise<TransactionObjectArgument> {
  // 1. Balance<Source> → Coin<Source> so the aggregator can consume it.
  const [sourceCoin] = tx.moveCall({
    target: '0x2::coin::from_balance',
    typeArguments: [sourceType],
    arguments: [sourceBalance],
  })
  if (!sourceCoin) {
    throw new Error('coin::from_balance did not return a coin')
  }

  // 2. Ask the aggregator for the best route. We always request
  //    `byAmountIn: true` because the vault already split a specific
  //    amount of Source out — we want to consume exactly that.
  //
  //    `pool` is a hint, not a hard filter: the SDK has no
  //    "must-use-this-pool" knob, so we leave routing open and let the
  //    quote pick what it picks. (A future pass could narrow `providers`
  //    using a hint-to-provider map, but every entry there is a
  //    maintenance burden — better to trust the aggregator.)
  void pool

  const router = await aggregator.findRouters({
    from: sourceType,
    target: destType,
    amount: new BN(amount),
    byAmountIn: true,
  })
  if (!router) {
    throw new Error('Cetus aggregator returned no route')
  }
  if (router.error) {
    throw new Error(`Cetus aggregator error: ${router.error.msg}`)
  }
  if (router.insufficientLiquidity) {
    throw new Error('Cetus aggregator: insufficient liquidity for this size')
  }

  // 3. Expand the route into moveCalls on our PTB. `routerSwap` takes
  //    our existing transaction and our existing Coin<Source> arg and
  //    returns a Coin<Dest>. It internally inserts whatever Pyth
  //    `update_price_feeds` calls are required by providers that need
  //    them (Pyth-priced AMMs).
  const destCoin = await aggregator.routerSwap({
    router,
    inputCoin: sourceCoin,
    slippage: DEFAULT_SLIPPAGE,
    txb: tx,
  })

  // 4. Coin<Dest> → Balance<Dest> so `auto_swap_deposit` can take it.
  const [destBalance] = tx.moveCall({
    target: '0x2::coin::into_balance',
    typeArguments: [destType],
    arguments: [destCoin],
  })
  if (!destBalance) {
    throw new Error('coin::into_balance did not return a balance')
  }
  return destBalance
}

// ─── PTB builder ─────────────────────────────────────────────────────────────

async function buildAutoSwapTx(
  req: AutoSwapRequest,
  sender: string,
  aggregator: AggregatorClient,
): Promise<Transaction> {
  const tx = new Transaction()
  tx.setSender(sender)

  // Latest package id — required for v4+ entries (`auto_swap_deposit_to_owner`)
  // and v7 entries (`*_v2`). Falls back to `packageId` when the caller
  // doesn't surface a separate id (back-compat with pre-v4 deploys).
  const pkgLatest = req.packageIdLatest ?? req.packageId

  // Branch on cap version. The Move v7 v2-suffixed entries take the
  // `&mut AutoSwapRegistryV2` as an additional first argument (after
  // the vault), which engages:
  //   • global pause kill switch
  //   • worker-role membership check
  //   • per-cap daily throttle (`used_today` / `max_per_day`)
  //   • dest allowlist (`assert_dest_allowed<Dest>`)
  // The v1 path stays untouched for back-compat.
  if (req.capVersion === 'v2') {
    if (!req.registryV2Id) {
      throw new Error(
        'registryV2Id is required when capVersion === "v2" (v7 hardened path)',
      )
    }

    // 1. v7 extract. Move signature:
    //    auto_swap_extract_v2<Source>(
    //      &mut TaliseVault,
    //      &mut AutoSwapRegistryV2,
    //      &mut AutoSwapCapV2<Source>,
    //      amount: u64,
    //      &Clock,
    //      &TxContext,
    //    ) -> (Balance<Source>, SwapTicket)
    //
    // The SDK auto-resolves the cap argument as Shared (v2 caps are
    // minted via `transfer::public_share_object` in `enable_auto_swap_v2`).
    const extractResult = tx.moveCall({
      target: `${pkgLatest}::vault::auto_swap_extract_v2`,
      typeArguments: [req.sourceType],
      arguments: [
        tx.object(req.vaultId),
        tx.object(req.registryV2Id),
        tx.object(req.capId),
        tx.pure.u64(req.amount),
        tx.object.clock(),
      ],
    })
    const sourceBalance = extractResult[0]
    const swapTicket = extractResult[1]
    if (!sourceBalance || !swapTicket) {
      throw new Error(
        'vault::auto_swap_extract_v2 did not return (balance, ticket)',
      )
    }

    // 2. Route through Cetus.
    const swappedBalance = await cetusSwap(
      tx,
      sourceBalance,
      req.sourceType,
      req.destType,
      req.pool,
      req.amount,
      aggregator,
    )

    // 3. v7 deposit-to-owner. Move signature:
    //    auto_swap_deposit_to_owner_v2<Dest>(
    //      &mut TaliseVault,
    //      &AutoSwapRegistryV2,
    //      Balance<Dest>,
    //      SwapTicket,
    //      &Clock,
    //      &mut TxContext,
    //    )
    // Note: registry passed by IMMUTABLE reference here (extract took
    // it `&mut` to bump `total_validations` + `used_today`). The SDK
    // re-uses the same shared-object input; Move's borrow-checker is
    // satisfied because the v2 entries take distinct mut/non-mut refs
    // across the PTB lifetime.
    tx.moveCall({
      target: `${pkgLatest}::vault::auto_swap_deposit_to_owner_v2`,
      typeArguments: [req.destType],
      arguments: [
        tx.object(req.vaultId),
        tx.object(req.registryV2Id),
        swappedBalance,
        swapTicket,
        tx.object.clock(),
      ],
    })

    return tx
  }

  // ── v1 path (unchanged) ───────────────────────────────────────────

  // 1. Extract source balance + SwapTicket hot-potato from the vault.
  //    Post-audit, `auto_swap_extract` returns `(Balance<Source>, SwapTicket)`
  //    where SwapTicket has no abilities — it MUST be consumed by
  //    `auto_swap_deposit` later in this same PTB. The destructuring
  //    here mirrors that Move return-tuple.
  const extractResult = tx.moveCall({
    target: `${req.packageId}::vault::auto_swap_extract`,
    typeArguments: [req.sourceType],
    arguments: [
      tx.object(req.vaultId),
      tx.object(req.registryId),
      tx.object(req.capId),
      tx.pure.u64(req.amount),
      tx.object.clock(),
    ],
  })
  const sourceBalance = extractResult[0]
  const swapTicket = extractResult[1]
  if (!sourceBalance || !swapTicket) {
    throw new Error('vault::auto_swap_extract did not return (balance, ticket)')
  }

  // 2. Route through the Cetus aggregator.
  const swappedBalance = await cetusSwap(
    tx,
    sourceBalance,
    req.sourceType,
    req.destType,
    req.pool,
    req.amount,
    aggregator,
  )

  // 3. Deposit the swap output STRAIGHT TO THE VAULT OWNER (the user's
  //    plain wallet) instead of into vault.balances, so auto-swapped
  //    USDsui shows up where the user is looking. The Move side also
  //    drains any stale Balance<Dest> still sitting in the bag from
  //    pre-v4 swaps, so the first tick after v4 flushes both at once.
  //
  //    Ticket consumption + vault_id assertion are unchanged — this
  //    is still the hot-potato closer for the PTB.
  tx.moveCall({
    // v4-only entry — must dispatch via the latest package id.
    target: `${pkgLatest}::vault::auto_swap_deposit_to_owner`,
    typeArguments: [req.destType],
    arguments: [
      tx.object(req.vaultId),
      swappedBalance,
      swapTicket,
      tx.object.clock(),
    ],
  })

  return tx
}

// ─── Client / keypair helpers ────────────────────────────────────────────────

let _grpc: SuiGrpcClient | null = null
let _grpcKey = ''
function getGrpc(bindings: Bindings): SuiGrpcClient {
  if (bindings.HAYABUSA) {
    // Hayabusa fetch isn't pinned here — auto-swap is one-shot so we
    // don't need the read-after-write pinning trick from /sponsor.
    return new SuiGrpcClient({
      network: bindings.SUI_NETWORK,
      baseUrl: bindings.SUI_GRPC_URL,
      fetch: ((input, init) => bindings.HAYABUSA!.fetch(input, init)) as typeof fetch,
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

// The Cetus aggregator SDK reads several Sui-mainnet object addresses
// (Pyth state, CLMM registry, etc.) off the client it's handed — those
// helpers exist on `SuiJsonRpcClient` but NOT on `SuiGrpcClient`, which
// is why feeding it the gRPC client crashes with
// `Cannot read properties of undefined (reading 'pythStateId')`. Cache
// a JSON-RPC client separately just for the aggregator.
let _aggClient: SuiJsonRpcClient | null = null
function getAggregatorClient(network: string): SuiJsonRpcClient {
  if (_aggClient) return _aggClient
  const net = network === 'mainnet' ? 'mainnet' : 'testnet'
  _aggClient = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(net),
    network: net,
  })
  return _aggClient
}

let _agg: AggregatorClient | null = null
let _aggKey = ''
function getAggregator(
  network: string,
  signer: string,
): AggregatorClient {
  // The SDK's `env` field is a NUMERIC enum at runtime: 0 = Mainnet,
  // 1 = Testnet. The type defs hide this behind a string union, but
  // `CONFIG[this.env]` is indexed by the int — pass a string and you
  // get `CONFIG['mainnet']` → undefined → `.pythStateId` TypeError.
  const envNum = network === 'mainnet' ? 0 : 1
  const key = `${envNum}:${signer}`
  if (_agg && _aggKey === key) return _agg
  _agg = new AggregatorClient({
    endpoint: CETUS_AGGREGATOR_ENDPOINT,
    // SDK is typed against SuiGrpcClient but at runtime reads helpers
    // that only exist on the JSON-RPC client (pythStateId, clmm registry,
    // etc.). Force-cast through `never`.
    client: getAggregatorClient(network) as never,
    signer,
    env: envNum as never,
    // 1% Talise fee → treasury, taken natively during the swap.
    overlayFeeRate: SWAP_FEE_RATE,
    overlayFeeReceiver: TREASURY_WALLET,
  })
  _aggKey = key
  return _agg
}

// ─── Route ───────────────────────────────────────────────────────────────────

const DEFAULT_EXECUTION_TIMEOUT_MS = 45_000

async function handleAutoSwap(c: Context<{ Bindings: Bindings }>) {
  const bindings = env<Bindings>(c)

  // Body parse
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Request body must be valid JSON.' }, 400)
  }

  const parsed = autoSwapBodySchema.safeParse(raw)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid request body.'
    return c.json({ ok: false, error: message }, 400)
  }
  const req = parsed.data

  // Sanity: source != dest is *probably* what the caller wants, but the
  // chain will accept a same-type "swap" — it just becomes a no-op route
  // through Cetus, which is harmless. So don't reject here.

  const keypair = getKeypair(bindings.SUI_MNEMONIC)
  const sender = keypair.toSuiAddress()
  const grpc = getGrpc(bindings)
  const aggregator = getAggregator(bindings.SUI_NETWORK, sender)

  // Build PTB
  let txBytes: Uint8Array
  try {
    const tx = await buildAutoSwapTx(req, sender, aggregator)
    txBytes = await tx.build({ client: grpc })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to build auto-swap transaction.'
    console.error('[auto-swap] build failed:', message, 'req:', JSON.stringify({
      vaultId: req.vaultId,
      capId: req.capId,
      sourceType: req.sourceType,
      destType: req.destType,
      amount: req.amount,
    }))
    return c.json({ ok: false, error: `Build failed: ${message}` }, 500)
  }

  // Execute
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
        message: 'Auto-swap execution timed out.',
      },
    )

    const tx =
      result.$kind === 'Transaction'
        ? result.Transaction
        : result.FailedTransaction
    const digest = tx?.digest ?? ''

    if (result.$kind === 'FailedTransaction') {
      const errMsg =
        result.FailedTransaction?.effects?.status?.error ?? 'Transaction failed.'
      return c.json(
        {
          ok: false,
          error: errMsg,
          digest,
          vaultId: req.vaultId,
          sourceType: req.sourceType,
          amount: req.amount,
        },
        500,
      )
    }

    return c.json({
      ok: true,
      digest,
      vaultId: req.vaultId,
      sourceType: req.sourceType,
      destType: req.destType,
      amount: req.amount,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Auto-swap execution failed.'
    return c.json(
      {
        ok: false,
        error: message,
        vaultId: req.vaultId,
        sourceType: req.sourceType,
        amount: req.amount,
      },
      500,
    )
  }
}

// ─── Hono sub-app ────────────────────────────────────────────────────────────

const autoSwap = new Hono<{ Bindings: Bindings }>()
autoSwap.use(cors())
autoSwap.post('/', handleAutoSwap)

export default autoSwap
export { handleAutoSwap, buildAutoSwapTx, cetusSwap, autoSwapBodySchema }
