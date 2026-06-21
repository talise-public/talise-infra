// Onara receive-from-accumulator-to-owner executor.
//
// Companion to /receive-from-accumulator for the v6 "USDsui direct to
// wallet" path. When the user receives USDsui (the dest type) at @handle,
// we don't want it sitting in the vault bag waiting for an unrelated
// swap to flush it. The Move function
// `vault::receive_from_accumulator_to_owner<T>(vault, amount, ctx)`
// drains the accumulator slot for type T and `public_transfer`s the
// resulting Coin<T> straight to `vault.owner` in one tx.
//
// Worker-signed leg. Anyone can call the Move entry — destination is
// hardwired to `vault.owner` (set at vault creation), no admin
// assertion.

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

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
  EXECUTION_TIMEOUT_MS?: string
  HAYABUSA?: { fetch: typeof fetch }
}

const moveTypeRegex =
  /^0x[0-9a-fA-F]{1,64}::[a-zA-Z_][a-zA-Z0-9_]*::[a-zA-Z_][a-zA-Z0-9_<>:,\s0-9a-fA-Fx]*$/

const objectIdField = z
  .string()
  .trim()
  .refine(isValidSuiObjectId, 'must be a 0x… Sui object id')

const bodySchema = z.object({
  vaultId: objectIdField,
  // Raw u64 amount to claim. Caller reads the live accumulator slot
  // via suix_getAllBalances and passes that here. Move asserts
  // `amount <= slot_value`, so overpulling reverts the whole tx.
  amount: z
    .string()
    .trim()
    .regex(/^\d+$/, 'amount must be a u64 decimal string'),
  coinType: z
    .string()
    .trim()
    .min(5, 'coinType missing')
    .regex(moveTypeRegex, 'coinType is not a valid Move type tag'),
  // Must be v6+ — receive_from_accumulator_to_owner was introduced in v6.
  // Older packages return a Move ABI error on unknown function.
  packageId: objectIdField,
})

export type ReceiveFromAccumulatorToOwnerRequest = z.infer<typeof bodySchema>

function buildTx(
  req: ReceiveFromAccumulatorToOwnerRequest,
  sender: string,
): Transaction {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.moveCall({
    target: `${req.packageId}::vault::receive_from_accumulator_to_owner`,
    typeArguments: [req.coinType],
    arguments: [tx.object(req.vaultId), tx.pure.u64(req.amount)],
  })
  return tx
}

// ─── Client / keypair (same cache pattern as autoSwap / receiveAndDeposit) ────

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

let _kp: Ed25519Keypair | null = null
let _kpMnemonic = ''
function getKeypair(mnemonic: string): Ed25519Keypair {
  if (_kp && _kpMnemonic === mnemonic) return _kp
  _kp = Ed25519Keypair.deriveKeypair(mnemonic)
  _kpMnemonic = mnemonic
  return _kp
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 45_000

async function handle(c: Context<{ Bindings: Bindings }>) {
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

  let txBytes: Uint8Array
  try {
    const tx = buildTx(req, sender)
    txBytes = await tx.build({ client: grpc })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Failed to build receive-from-accumulator-to-owner transaction.'
    console.error(
      '[recv-acc-owner] build failed:',
      message,
      'req:',
      JSON.stringify(req),
    )
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
        message: 'receive-from-accumulator-to-owner execution timed out.',
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
          coinType: req.coinType,
          amount: req.amount,
        },
        500,
      )
    }

    return c.json({
      ok: true,
      digest,
      vaultId: req.vaultId,
      coinType: req.coinType,
      amount: req.amount,
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'receive-from-accumulator-to-owner execution failed.'
    return c.json(
      {
        ok: false,
        error: message,
        vaultId: req.vaultId,
        coinType: req.coinType,
        amount: req.amount,
      },
      500,
    )
  }
}

const app = new Hono<{ Bindings: Bindings }>()
app.use('*', cors())
app.post('/', handle)
export default app
