export type RawSponsorPolicy = Record<string, unknown>

// ─── Sponsor policy: allow-all with gas caps ─────────────────────────────────
//
// Onara is GAS-ONLY sponsorship — the user signs their own transaction, so
// every coin/value movement is authorized by *their* key; Onara only co-signs
// to pay gas. The real access gate is upstream (`/api/zk/sponsor` is behind
// app-attest + bearer auth), so the only residual risk here is gas-griefing,
// which the per-tx caps below bound.
//
// We allow any target because Talise's flows legitimately call MANY packages:
//   • Talise core (send / vault / auto_swap / receipt)
//   • Cetus aggregator + CLMM pools + other DEXs (swaps / wallet-sweep)
//   • Navi + Scallop (earn / save)
//   • DeepBook, cheque/stream packages, …
// A curated allowlist silently breaks any flow whose package id drifts (e.g.
// a Cetus router upgrade), so we instead bound by gas + command count.
//
// gasBudgetMax 100_000_000 MIST = 0.1 SUI — comfortably above a multi-hop
// Cetus swap (~<0.01 SUI) while capping a single griefing tx at 0.1 SUI.
const ALLOW_ALL_CAPPED: RawSponsorPolicy = {
  name: 'allow-all-capped',
  // `action` (not `mode`) is the schema field; allow + universal target.
  action: 'allow',
  enabled: true,
  gasBudgetMax: 100_000_000,
  maxCommands: 64,
  targets: ['*'],
  allowedCommandKinds: [
    'SplitCoins',
    'MergeCoins',
    'TransferObjects',
    'MoveCall',
    'MakeMoveVec',
    'Upgrade',
  ],
}

/**
 * Build the runtime sponsor policy list. We return the allow-all-with-caps
 * policy unconditionally — `packageId` is accepted for signature/back-compat
 * (and future per-package tightening) but no longer gates sponsorship, since
 * earns/swaps call non-Talise packages and were being rejected otherwise.
 */
export function resolveSponsorPolicies(_packageId?: string | undefined): RawSponsorPolicy[] {
  return [structuredClone(ALLOW_ALL_CAPPED)]
}

// Default export kept for back-compat with code that imports the raw list.
const sponsorPolicies: RawSponsorPolicy[] = [ALLOW_ALL_CAPPED]

export default sponsorPolicies
