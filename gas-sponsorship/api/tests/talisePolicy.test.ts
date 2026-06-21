/**
 * Talise sponsor-policy guardrail tests.
 *
 * These tests pin the production sponsor policy to:
 *   - only the four Talise Move modules (send/vault/auto_swap/receipt),
 *   - a 20M MIST gas cap,
 *   - command kinds that exclude Publish.
 *
 * Without these tests the JSON could quietly regress to the previous
 * `targets: ["*"]` + `Publish` allow-all shape.
 */

import { describe, expect, test } from 'bun:test'
import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { loadPolicies, validateSponsoredTxPayload } from '../src/policy'
import { resolveSponsorPolicies } from '../policies'

const SENDER = '0x0000000000000000000000000000000000000000000000000000000000000001'
const SPONSOR = '0x0000000000000000000000000000000000000000000000000000000000000002'
const TALISE_PKG = '0x000000000000000000000000000000000000000000000000000000000000abcd'
const OTHER_PKG = '0x000000000000000000000000000000000000000000000000000000000000beef'
const ZERO_DIGEST = '11111111111111111111111111111111'

const talisePolicies = loadPolicies(resolveSponsorPolicies(TALISE_PKG))

async function build(setup: (tx: Transaction) => void, opts?: { gasBudget?: number }) {
  const tx = new Transaction()
  tx.setSender(SENDER)
  tx.setGasOwner(SPONSOR)
  tx.setGasBudget(opts?.gasBudget ?? 10_000_000)
  tx.setGasPrice(1000)
  tx.setGasPayment([
    { objectId: '0x0000000000000000000000000000000000000000000000000000000000000000', version: '0', digest: ZERO_DIGEST },
  ])
  setup(tx)
  return toBase64(await tx.build())
}

function validate(txBytes: string) {
  return validateSponsoredTxPayload({
    txBytesBase64: txBytes,
    expectedSender: SENDER,
    expectedSponsor: SPONSOR,
    policies: talisePolicies,
    senderName: null,
  })
}

describe('Talise sponsor policy guardrails', () => {
  test('accepts a MoveCall against talise::send', async () => {
    const txBytes = await build((tx) => {
      tx.moveCall({ target: `${TALISE_PKG}::send::send` })
    })
    expect(validate(txBytes).matchedPolicyName).toBe('talise')
  })

  test('accepts a MoveCall against talise::vault and talise::auto_swap', async () => {
    const txBytes = await build((tx) => {
      tx.moveCall({ target: `${TALISE_PKG}::vault::deposit` })
      tx.moveCall({ target: `${TALISE_PKG}::auto_swap::pause` })
    })
    expect(validate(txBytes).matchedPolicyName).toBe('talise')
  })

  test('denies a MoveCall against a non-Talise package', async () => {
    const txBytes = await build((tx) => {
      tx.moveCall({ target: `${OTHER_PKG}::evil::drain` })
    })
    expect(() => validate(txBytes)).toThrow()
  })

  test('denies a MoveCall against a non-Talise module on the same package', async () => {
    // Module not in {send, vault, auto_swap, receipt}
    const txBytes = await build((tx) => {
      tx.moveCall({ target: `${TALISE_PKG}::admin::publish_thing` })
    })
    expect(() => validate(txBytes)).toThrow()
  })

  test('denies a Publish command kind', async () => {
    // Tx.publish injects a `Publish` command. We don't have a real
    // compiled module here, so we feed two empty byte vectors as the
    // module list and dependency list. The policy validator runs
    // before the chain ever sees the tx, so a synthetic publish
    // command is enough to exercise the denial path.
    const txBytes = await build((tx) => {
      tx.moveCall({ target: `${TALISE_PKG}::send::send` })
      // Manually push a Publish command onto the txData. The SDK's
      // public API doesn't expose `tx.publish` without real module
      // bytes, so we use the lower-level `add` helper.
      ;(tx as unknown as {
        add: (cmd: unknown) => void
      }).add({
        $kind: 'Publish',
        Publish: {
          modules: [],
          dependencies: [],
        },
      })
    })
    expect(() => validate(txBytes)).toThrow(/command kind not allowed/i)
  })

  test('denies a tx whose gas budget exceeds the 20M MIST cap', async () => {
    const txBytes = await build(
      (tx) => tx.moveCall({ target: `${TALISE_PKG}::send::send` }),
      { gasBudget: 50_000_000 },
    )
    // Over-budget txs don't match the allow policy and produce a
    // "no policy matched" style error (the gas check is a continue,
    // so validation falls through to the no-match branch).
    expect(() => validate(txBytes)).toThrow()
  })
})

describe('resolveSponsorPolicies', () => {
  test('returns an empty list when packageId is undefined', () => {
    expect(resolveSponsorPolicies(undefined)).toEqual([])
  })

  test('returns an empty list when packageId is empty', () => {
    expect(resolveSponsorPolicies('')).toEqual([])
    expect(resolveSponsorPolicies('   ')).toEqual([])
  })

  test('substitutes the package id token in targets', () => {
    const resolved = resolveSponsorPolicies(TALISE_PKG) as Array<{
      targets: string[]
    }>
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.targets).toEqual([
      `${TALISE_PKG}::send::*`,
      `${TALISE_PKG}::vault::*`,
      `${TALISE_PKG}::auto_swap::*`,
      `${TALISE_PKG}::receipt::*`,
    ])
  })

  test('does not allow Publish command kind', () => {
    const resolved = resolveSponsorPolicies(TALISE_PKG) as Array<{
      allowedCommandKinds: string[]
    }>
    expect(resolved[0]!.allowedCommandKinds).not.toContain('Publish')
  })
})
