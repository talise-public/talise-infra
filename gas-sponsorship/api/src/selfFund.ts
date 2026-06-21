// Onara self-fund executor (admin).
//
// Fixes the "funded but 0 active" state: SUI sent to the sponsor address as a
// plain transfer lands as a Coin<SUI> object (reported as `pending` /
// coinBalance), but Onara sponsors from the ADDRESS BALANCE accumulator
// (`active` / addressBalance). This endpoint has the sponsor sign ONE tx that
// moves its own plain SUI into its own accumulator via `0x2::coin::send_funds`
// — i.e. the documented funding path, run by the sponsor on coins it already
// owns. Pays gas from the same coin (no active gas needed → no deadlock),
// reserving a small remainder.
//
// Admin-guarded: requires header `x-admin-token` === ADMIN_TOKEN. If
// ADMIN_TOKEN is unset the endpoint refuses (never unguarded — it moves money).

import type { Context } from 'hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { env } from 'hono/adapter'
import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import pRetry from 'p-retry'
import pTimeout from 'p-timeout'

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
  ADMIN_TOKEN?: string
  EXECUTION_TIMEOUT_MS?: string
  HAYABUSA?: { fetch: typeof fetch }
}

const SUI_TYPE = '0x2::sui::SUI'
// Gas headroom left as a plain coin so the sweep tx can pay its own gas.
const GAS_RESERVE_MIST = 20_000_000n // 0.02 SUI (actual gas ~0.001–0.003)
const DEFAULT_EXECUTION_TIMEOUT_MS = 45_000

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
  _grpc = new SuiGrpcClient({ network: bindings.SUI_NETWORK, baseUrl: bindings.SUI_GRPC_URL })
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

async function handle(c: Context<{ Bindings: Bindings }>) {
  const bindings = env<Bindings>(c)

  // ── Admin guard ──────────────────────────────────────────────────────
  if (!bindings.ADMIN_TOKEN) {
    return c.json({ ok: false, error: 'ADMIN_TOKEN not configured; endpoint disabled.' }, 503)
  }
  if (c.req.header('x-admin-token') !== bindings.ADMIN_TOKEN) {
    return c.json({ ok: false, error: 'unauthorized' }, 401)
  }

  const keypair = getKeypair(bindings.SUI_MNEMONIC)
  const sender = keypair.toSuiAddress()
  const grpc = getGrpc(bindings)

  // Read current buckets.
  let coinBalance = 0n
  let addressBalanceBefore = '0'
  try {
    const bal = await grpc.getBalance({ owner: sender })
    coinBalance = BigInt(bal.balance.coinBalance ?? '0')
    addressBalanceBefore = bal.balance.addressBalance ?? '0'
  } catch (e) {
    return c.json({ ok: false, error: `balance read failed: ${e instanceof Error ? e.message : String(e)}` }, 502)
  }

  // Sweep everything except a small gas reserve.
  const sweep = coinBalance - GAS_RESERVE_MIST
  if (sweep <= 0n) {
    return c.json(
      {
        ok: false,
        error: 'nothing to sweep — plain coin balance is at or below the gas reserve.',
        sponsor: sender,
        coinBalance: coinBalance.toString(),
        gasReserveMist: GAS_RESERVE_MIST.toString(),
      },
      400,
    )
  }

  // Build: split `sweep` off the gas coin, deposit into the sponsor's OWN
  // accumulator via coin::send_funds<SUI>(coin, sender).
  let txBytes: Uint8Array
  try {
    const tx = new Transaction()
    tx.setSender(sender)
    const [chunk] = tx.splitCoins(tx.gas, [tx.pure.u64(sweep)])
    tx.moveCall({
      target: '0x2::coin::send_funds',
      typeArguments: [SUI_TYPE],
      arguments: [chunk, tx.pure.address(sender)],
    })
    txBytes = await tx.build({ client: grpc })
  } catch (e) {
    return c.json({ ok: false, error: `build failed: ${e instanceof Error ? e.message : String(e)}` }, 500)
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
      { milliseconds: executionTimeoutMs, message: 'self-fund execution timed out.' },
    )
    const txr = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction
    const digest = txr?.digest ?? ''
    if (result.$kind === 'FailedTransaction') {
      return c.json(
        { ok: false, error: result.FailedTransaction?.effects?.status?.error ?? 'transaction failed', digest },
        500,
      )
    }
    return c.json({
      ok: true,
      digest,
      sponsor: sender,
      sweptMist: sweep.toString(),
      sweptSui: (Number(sweep) / 1e9).toFixed(4),
      addressBalanceBefore,
      note: 'Swept plain coin into the address-balance accumulator. GET /status should now show active > 0.',
    })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'self-fund execution failed.' }, 500)
  }
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())
app.post('/', handle)
export default app
