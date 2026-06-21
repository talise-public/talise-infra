// Onara wallet-sweep PTB builder.
//
// Companion to /auto-swap, but for PLAIN-wallet coins (not vault-held
// ones). The user has WAL + SUI + USDC etc. sitting in their address
// and wants one tap to convert everything to USDsui. Each non-USDsui
// coin becomes one Cetus-aggregator leg; all legs go into a SINGLE
// PTB so the user signs once and the whole sweep settles atomically
// (no partial-conversion state).
//
// Critical: this route only BUILDS the PTB — it does NOT sign it. The
// owner (the user's zkLogin address) is the sender, so the response
// shape mirrors /api/vault/enable-autoswap: { bytesB64, sender }. The
// iOS app feeds bytesB64 into ZkLoginCoordinator.signAndSubmit, which
// routes through the existing /api/zk/sponsor + /api/zk/sponsor-execute
// pair for Onara-paid gas.
//
// Aggregator usage mirrors autoSwap.ts:cetusSwap — same SDK, same
// endpoint, same JSON-RPC client trick. Difference is the input coin
// source: here we use `coinWithBalance` to let the PTB resolve the
// owner's Coin<T> objects (or address-balance pool, for SUI) at build
// time, rather than receiving a Balance<T> from a Move extract.

import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from 'hono/adapter'
import { z } from 'zod'
import {
  Transaction,
  coinWithBalance,
  type TransactionObjectArgument,
} from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc'
import { isValidSuiAddress } from '@mysten/sui/utils'
import { toBase64 } from '@mysten/sui/utils'
import { AggregatorClient } from '@cetusprotocol/aggregator-sdk'
import BN from 'bn.js'

// ─── Tunables ────────────────────────────────────────────────────────────────

/// 1% slippage — same default the autoSwap.ts vault path uses. The user
/// opted into a "best-effort convert everything" gesture; tightening
/// below 1% routinely fails on long-tail coins (WAL, etc.) at small
/// sizes because the route fans through one or two thin pools.
const DEFAULT_SLIPPAGE = 0.01

const CETUS_AGGREGATOR_ENDPOINT = 'https://api-sui.cetus.zone/router_v3'

/// Talise swap fee — 1% of every conversion is skimmed to the treasury
/// via the Cetus aggregator's NATIVE overlay fee (baked into the route +
/// swap moveCalls; no manual coin split). Keep in sync with
/// `SWAP_FEE_BPS` in web/app/api/swap/prepare/route.ts (100 bps).
const SWAP_FEE_RATE = 0.01
/// Treasury that collects the overlay fee. Mirrors `TREASURY_WALLET` in
/// web/lib/navi-supply.ts.
const TREASURY_WALLET =
  '0xc0bf1c51e44f8cfa4a06f16a2408effa3507ac4582744c7ead56078b5e251a48'

/// USDsui destination type. Env-overridable for testnet redeploys; in
/// practice mainnet is the only place this matters.
const DEFAULT_USDSUI_TYPE =
  '0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI'

// ─── Env shape ───────────────────────────────────────────────────────────────

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  USDSUI_TYPE?: string
  HAYABUSA?: { fetch: typeof fetch }
}

// ─── Request validation ──────────────────────────────────────────────────────

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

const bodySchema = z.object({
  owner: z
    .string()
    .trim()
    .refine(isValidSuiAddress, 'owner must be a 0x… Sui address'),
  coins: z
    .array(
      z.object({
        coinType: z
          .string()
          .trim()
          .min(5, 'coinType missing')
          .regex(moveTypeRegex, 'coinType is not a valid Move type tag'),
        amount: u64String,
      }),
    )
    .min(1, 'coins[] must be non-empty')
    .max(8, 'coins[] capped at 8 legs per sweep'),
})

export type WalletSweepRequest = z.infer<typeof bodySchema>

// ─── Aggregator client cache (mirrors autoSwap.ts) ───────────────────────────

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
function getAggregator(network: string, signer: string): AggregatorClient {
  // SDK's `env` is a numeric enum at runtime (0 = Mainnet, 1 = Testnet)
  // — same caveat documented in autoSwap.ts.
  const envNum = network === 'mainnet' ? 0 : 1
  const key = `${envNum}:${signer}`
  if (_agg && _aggKey === key) return _agg
  _agg = new AggregatorClient({
    endpoint: CETUS_AGGREGATOR_ENDPOINT,
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

let _grpc: SuiGrpcClient | null = null
let _grpcKey = ''
function getGrpc(bindings: Bindings): SuiGrpcClient {
  if (bindings.HAYABUSA) {
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

// ─── PTB construction ────────────────────────────────────────────────────────

/// Add a single Cetus-aggregator leg to `tx` that converts `amount` of
/// `coinType` (owned by `owner`) into `destType` and transfers the
/// resulting Coin<dest> back to `owner`. Returns the quoted destType
/// output amount (raw u64 string) so the caller can total the sweep's
/// estimated USDsui out (used for the swap rewards-points credit).
async function addCetusLeg(
  tx: Transaction,
  owner: string,
  coinType: string,
  destType: string,
  amount: string,
  aggregator: AggregatorClient,
): Promise<string> {
  // 1. Resolve the input coin from the owner's address. coinWithBalance
  //    handles both Coin<T> objects and the May-2026 Address Balance
  //    pool (for SUI). useGasCoin: false — when this is later wrapped
  //    in a sponsored tx the gas coin belongs to Onara, not the owner.
  const inputCoin = tx.add(
    coinWithBalance({
      type: coinType,
      balance: BigInt(amount),
      useGasCoin: false,
    }),
  )

  // 2. Quote the route and splice it into the PTB.
  const router = await aggregator.findRouters({
    from: coinType,
    target: destType,
    amount: new BN(amount),
    byAmountIn: true,
  })
  if (!router) {
    throw new Error(`Cetus: no route for ${coinType} → ${destType}`)
  }
  if (router.error) {
    throw new Error(`Cetus aggregator error: ${router.error.msg}`)
  }
  if (router.insufficientLiquidity) {
    throw new Error(
      `Cetus: insufficient liquidity for ${coinType} amount ${amount}`,
    )
  }

  const outputCoin = await aggregator.routerSwap({
    router,
    inputCoin,
    slippage: DEFAULT_SLIPPAGE,
    txb: tx,
  })

  // 3. Drop the output USDsui into the owner's wallet.
  tx.transferObjects([outputCoin], owner)
  // Quoted output (raw u64) — net of the overlay fee per the aggregator's
  // accounting. Summed by the caller for the points credit.
  return router.amountOut.toString()
}

async function buildWalletSweepTx(
  req: WalletSweepRequest,
  destType: string,
  aggregator: AggregatorClient,
): Promise<{ tx: Transaction; estUsdsuiOut: bigint }> {
  const tx = new Transaction()
  tx.setSender(req.owner)

  let estUsdsuiOut = 0n
  for (const leg of req.coins) {
    // Skip self-swaps — the aggregator accepts a same-type route but
    // it's wasted gas. Caller shouldn't ask for one, but be defensive.
    if (leg.coinType === destType) continue
    const out = await addCetusLeg(
      tx,
      req.owner,
      leg.coinType,
      destType,
      leg.amount,
      aggregator,
    )
    try {
      estUsdsuiOut += BigInt(out)
    } catch {
      // Defensive: a non-numeric quote shouldn't sink the whole sweep —
      // it just won't contribute to the points estimate.
    }
  }
  return { tx, estUsdsuiOut }
}

// ─── Route ───────────────────────────────────────────────────────────────────

async function handleWalletSweep(c: Context<{ Bindings: Bindings }>) {
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

  const destType = bindings.USDSUI_TYPE || DEFAULT_USDSUI_TYPE
  const grpc = getGrpc(bindings)
  // The aggregator's `signer` value is purely informational at PTB-build
  // time (the SDK doesn't actually sign here — we only call findRouters
  // + routerSwap, which build moveCalls). Using the owner address keeps
  // the SDK's internal caching keyed correctly per-user.
  const aggregator = getAggregator(bindings.SUI_NETWORK, req.owner)

  let bytes: Uint8Array
  let estUsdsuiOut = 0n
  try {
    const built = await buildWalletSweepTx(req, destType, aggregator)
    estUsdsuiOut = built.estUsdsuiOut
    // onlyTransactionKind: true — the bytes are wrapped into a sponsored
    // TransactionData downstream by /api/zk/sponsor, so we must not bake
    // gas data into them here.
    bytes = await built.tx.build({
      client: grpc as never,
      onlyTransactionKind: true,
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to build wallet-sweep transaction.'
    console.error(
      '[wallet-sweep] build failed:',
      message,
      'owner:',
      req.owner,
      'legs:',
      req.coins.length,
    )
    return c.json({ ok: false, error: `Build failed: ${message}` }, 500)
  }

  return c.json({
    ok: true,
    bytesB64: toBase64(bytes),
    sender: req.owner,
    // Quoted USDsui output (raw u64, 6-dp) summed across legs — net of the
    // 1% overlay fee. The web layer forwards it so iOS can credit swap
    // rewards points (kind: "swap") at sponsor-execute time.
    estUsdsuiOut: estUsdsuiOut.toString(),
  })
}

// ─── Hono sub-app ────────────────────────────────────────────────────────────

const walletSweep = new Hono<{ Bindings: Bindings }>()
walletSweep.use(cors())
walletSweep.post('/', handleWalletSweep)

export default walletSweep
export { handleWalletSweep, buildWalletSweepTx, bodySchema }
