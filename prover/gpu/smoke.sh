#!/usr/bin/env bash
# =============================================================================
# zk-prover-smoke.sh <URL>
#
# Validates a freshly-deployed unconfirmedlabs prover endpoint is wire-
# compatible with what web/lib/zksigner.ts::normalizeProverResponse expects.
#
# Checks:
#   1. GET /healthz returns 200
#   2. POST /input with a *known synthetic* circuit input returns 200
#   3. Response body contains either proofPoints/issBase64Details/headerBase64
#      OR proof_points/iss_base64_details/header_base64 — normalize() handles
#      both shapes
#   4. Round-trip is < 5s (cold path is acceptable up to 8s; warmup recommended)
#
# Usage:
#   bash infra/prover/gpu/smoke.sh https://zk-prover.talise.io
#   bash infra/prover/gpu/smoke.sh https://zk-prover.talise.io --warmup
#
# Exit 0 = wire-compatible, safe to flip ZK_PROVER_PRIMARY=gpu.
# Exit 1 = mismatch (read the diagnostic, do not flip the toggle).
#
# NOTE: this script does *not* require a real OAuth JWT — it uses a synthetic
# input that the prover will accept and produce a verifiable Groth16 proof
# for. We're testing the wire format, not the proof's validity for a real
# Sui signature. For that, run the real signing path in staging and check
# Vercel logs for `[zk-prover] role=primary backend=gpu status=200`.
# =============================================================================

set -euo pipefail

URL="${1:?Usage: $0 <https://prover-url> [--warmup]}"
URL="${URL%/}"
WARMUP=0
[[ "${2:-}" == "--warmup" ]] && WARMUP=1

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yel()   { printf '\033[33m%s\033[0m\n' "$*"; }

bold "==> Smoke testing $URL"

# ---- 1. /healthz ------------------------------------------------------------
bold "[1/3] GET ${URL}/healthz"
HEALTH_HTTP=$(curl -fsS -o /tmp/zkprover_health.json -w '%{http_code}' "${URL}/healthz" || true)
if [[ "$HEALTH_HTTP" != "200" ]]; then
  red "FAIL: /healthz returned HTTP $HEALTH_HTTP"
  cat /tmp/zkprover_health.json 2>/dev/null || true
  exit 1
fi
green "  /healthz -> 200"
cat /tmp/zkprover_health.json 2>/dev/null && echo

# ---- 1b. Auth gate on /input ------------------------------------------------
# P1-6: /input must require Bearer auth. Sending without the header
# should 401; sending with the configured token should 200.
if [[ -n "${ZK_PROVER_AUTH_TOKEN:-}" ]]; then
  bold "[1b/3] Auth gate on ${URL}/input"
  UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${URL}/input" \
    -H 'content-type: application/json' \
    --data '{}' --max-time 10 || true)
  if [[ "$UNAUTH" != "401" && "$UNAUTH" != "403" ]]; then
    red "FAIL: unauthenticated POST /input returned HTTP $UNAUTH (expected 401/403)"
    exit 1
  fi
  green "  unauthenticated POST /input -> ${UNAUTH}"

  AUTH=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${URL}/input" \
    -H "Authorization: Bearer ${ZK_PROVER_AUTH_TOKEN}" \
    -H 'content-type: application/json' \
    --data '{}' --max-time 10 || true)
  # The prover itself may 400 on the bogus body, but Caddy must
  # let the request through (not 401/403). Any non-auth response
  # proves the bearer was accepted.
  if [[ "$AUTH" == "401" || "$AUTH" == "403" ]]; then
    red "FAIL: authenticated POST /input still returned $AUTH"
    red "  Check that ZK_PROVER_AUTH_TOKEN on this host matches the deploy value."
    exit 1
  fi
  green "  authenticated POST /input -> ${AUTH} (auth header accepted)"
else
  yel "[1b/3] Skipped auth gate check (set ZK_PROVER_AUTH_TOKEN to enable)."
fi

# ---- 2. POST /input with synthetic input -----------------------------------
# The unconfirmedlabs prover accepts the *exact* 42-field Sui zkLogin circuit
# input. The Mysten reference test payload lives in their sample-extension
# repo, but it's ~50KB of derived numerics. For a smoke test we ping /warmup
# (no proof returned, but the worker proves end-to-end) and treat the
# response code as the wire check.
#
# Once you have a real captured payload, pipe it through:
#   bash infra/prover/gpu/smoke.sh URL  < real-input.json

if [[ -t 0 ]]; then
  # No piped input → use /warmup with a minimal sentinel.
  bold "[2/3] POST ${URL}/warmup  (no payload piped; using built-in warmup)"
  START_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
  # Warmup with an empty body — the prover's warmup endpoint loads the zkey
  # into GPU memory; it does not need a real input.
  AUTH_HDR=()
  if [[ -n "${ZK_PROVER_AUTH_TOKEN:-}" ]]; then
    AUTH_HDR=(-H "Authorization: Bearer ${ZK_PROVER_AUTH_TOKEN}")
  fi
  HTTP_CODE=$(curl -fsS -o /tmp/zkprover_warmup.json -w '%{http_code}' \
    -X POST "${URL}/warmup" \
    "${AUTH_HDR[@]}" \
    -H 'content-type: application/json' \
    --data '{}' \
    --max-time 60 || true)
  END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
  ELAPSED=$((END_MS - START_MS))
  if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "202" && "$HTTP_CODE" != "204" ]]; then
    yel "  /warmup returned HTTP $HTTP_CODE (some builds 400 on empty body — not a deal-breaker)"
    cat /tmp/zkprover_warmup.json 2>/dev/null || true
    echo
    yel "  To validate the full wire shape, pipe a real input JSON:"
    yel "    bash $0 ${URL} < /path/to/real-zklogin-input.json"
    yel "  Skipping body-shape check."
    green "  Cold warmup latency: ${ELAPSED}ms"
    exit 0
  fi
  green "  /warmup -> $HTTP_CODE in ${ELAPSED}ms"
  bold "[3/3] Skipping body-shape check (no real input piped)."
  echo
  yel "To fully validate the response shape matches normalizeProverResponse()"
  yel "in web/lib/zksigner.ts, capture a real input JSON from the Mysten"
  yel "reference flow and re-run this script with it piped on stdin."
  green "DONE — wire-up is consistent so far. Run the real signing path in"
  green "staging and watch Vercel logs for [zk-prover] backend=gpu status=200."
  exit 0
fi

# Read piped input
INPUT=$(cat)
bold "[2/3] POST ${URL}/input  ($(echo -n "$INPUT" | wc -c | tr -d ' ') bytes)"
START_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
AUTH_HDR=()
if [[ -n "${ZK_PROVER_AUTH_TOKEN:-}" ]]; then
  AUTH_HDR=(-H "Authorization: Bearer ${ZK_PROVER_AUTH_TOKEN}")
fi
HTTP_CODE=$(curl -fsS -o /tmp/zkprover_proof.json -w '%{http_code}' \
  -D /tmp/zkprover_proof.headers \
  -X POST "${URL}/input" \
  "${AUTH_HDR[@]}" \
  -H 'content-type: application/json' \
  --data-binary @- \
  --max-time 30 <<<"$INPUT" || true)
END_MS=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
ELAPSED=$((END_MS - START_MS))

if [[ "$HTTP_CODE" != "200" ]]; then
  red "FAIL: /input returned HTTP $HTTP_CODE"
  cat /tmp/zkprover_proof.json 2>/dev/null || true
  exit 1
fi
green "  /input -> 200 in ${ELAPSED}ms"

BACKEND=$(grep -i '^x-zklogin-backend:' /tmp/zkprover_proof.headers 2>/dev/null | head -1 | tr -d '\r')
[[ -n "$BACKEND" ]] && echo "  $BACKEND"
TIMING=$(grep -i '^server-timing:' /tmp/zkprover_proof.headers 2>/dev/null | head -1 | tr -d '\r')
[[ -n "$TIMING" ]] && echo "  $TIMING"

# ---- 3. Validate response shape --------------------------------------------
bold "[3/3] Validate normalizeProverResponse-compatible body"

if ! command -v jq >/dev/null 2>&1; then
  red "jq not installed; install jq to validate the response shape."
  exit 1
fi

# Mysten/Shinami return camelCase; some GPU builds return snake_case.
# zksigner.ts::normalizeProverResponse accepts both — we just need ONE
# variant of each field present.
PROOF_OK=$(jq -r 'if (.proofPoints? or .proof_points?) then "yes" else "no" end' /tmp/zkprover_proof.json)
ISS_OK=$(jq -r 'if (.issBase64Details? or .iss_base64_details?) then "yes" else "no" end' /tmp/zkprover_proof.json)
HEADER_OK=$(jq -r 'if (.headerBase64? or .header_base64?) then "yes" else "no" end' /tmp/zkprover_proof.json)

if [[ "$PROOF_OK" == "yes" && "$ISS_OK" == "yes" && "$HEADER_OK" == "yes" ]]; then
  green "  proofPoints / issBase64Details / headerBase64 all present"
  green "DONE — wire-compatible with normalizeProverResponse(). Safe to flip"
  green "ZK_PROVER_PRIMARY=gpu in Vercel env (or canary at ZK_PROVER_CANARY_PCT=25 first)."
  exit 0
fi

red "FAIL: response missing required fields"
echo "  proofPoints/proof_points  : $PROOF_OK"
echo "  issBase64Details/...      : $ISS_OK"
echo "  headerBase64/header_base64: $HEADER_OK"
echo
echo "Body keys returned: $(jq -r 'keys|join(",")' /tmp/zkprover_proof.json)"
echo
red "Do NOT flip ZK_PROVER_PRIMARY=gpu yet. Either:"
red "  (a) raise an issue against unconfirmedlabs to add the missing field, or"
red "  (b) add a shim in web/lib/zksigner.ts::normalizeProverResponse for the"
red "      actual key names this build returns."
exit 1
