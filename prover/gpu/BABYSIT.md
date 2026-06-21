# Babysit the GPU prover cutover

48-hour playbook. Drives the canary roll-out from 0% -> 100% on the
unconfirmedlabs GPU prover, while keeping Shinami as the auto-fallback
on every step. Every step has a single-env-var rollback (~3 min recovery).

Pre-reqs (already true at the time of writing):

- Vercel project `talise-main` is linked locally (`web/.vercel/project.json`).
- Vercel env (production) has three pre-set vars:
  - `ZK_PROVER_PRIMARY=shinami`
  - `ZK_PROVER_FALLBACK=shinami`
  - `ZK_PROVER_CANARY_PCT=0`
- `web/lib/zksigner.ts` contains the toggle (commit `f00cd6b`).
- Deploy script: `infra/prover/gpu/deploy.sh` (commit `d1e6f37`).
- Smoke script: `infra/prover/gpu/smoke.sh`.

DNS:
- A record for `zk-prover.talise.io` will be created at T+5m.
- We use Caddy's automatic Let's Encrypt cert on the GPU box.

---

## T+0  Provision the GPU box

User pastes their RunPod API key. Run the deploy script.

```bash
export RUNPOD_API_KEY=...   # paste here
cd /Users/eromonseleodigie/Talise
bash infra/prover/gpu/deploy.sh --target=runpod
```

Outputs:
- Pod ID
- Public IP + SSH port
- Final instruction to point `zk-prover.talise.io` -> the IP

If it errors before printing the IP, read the stderr and re-run after fixing
the env. The script is idempotent at the docker layer (`docker rm -f
zklogin-prover && docker run ...` re-runs cleanly).

Rollback: nothing to roll back yet.

---

## T+5m  DNS + first Let's Encrypt cert

In Cloudflare (or wherever talise.io lives):
- Add A record: `zk-prover.talise.io` -> `<IP from T+0>`. TTL 60s, proxy OFF
  (Caddy needs port 80 reachable for ACME).

Wait ~2 min for propagation, then trigger the first cert by hitting the host:

```bash
curl -v https://zk-prover.talise.io/healthz
```

The first hit can take ~20-40s while Caddy completes the ACME HTTP-01
challenge. Subsequent hits should be sub-second.

Rollback: delete the A record. The GPU host is still up but unreachable
externally; no Vercel impact (we haven't pointed at it yet).

---

## T+10m  Smoke

```bash
bash infra/prover/gpu/smoke.sh https://zk-prover.talise.io
```

Must exit 0 with "wire-up is consistent so far". If exit != 0, do NOT
proceed — read the failure and fix on the GPU box. Common issues:
- 404 on /healthz: image didn't start. SSH in, `docker logs zklogin-prover`.
- DNS not propagated: wait 2 more minutes, retry.
- Cert pending: hit the URL twice with 20s gap.

Rollback: nothing on Vercel side yet.

---

## T+15m  Wire Vercel at 25% canary

```bash
cd /Users/eromonseleodigie/Talise/web
printf 'https://zk-prover.talise.io/input' | vercel env add ZK_PROVER_GPU_URL production
vercel env rm ZK_PROVER_CANARY_PCT production --yes
printf '25' | vercel env add ZK_PROVER_CANARY_PCT production
vercel --prod
```

`ZK_PROVER_PRIMARY` stays at `shinami`. The 25% canary means 1-in-4 requests
hit the GPU prover; the other 3-in-4 still hit Shinami. Any 5xx/timeout on
the GPU side auto-falls-back to Shinami within the same request (see
`callProverWithFallback`).

Rollback (instant, 30s):
```bash
vercel env rm ZK_PROVER_CANARY_PCT production --yes
printf '0' | vercel env add ZK_PROVER_CANARY_PCT production
vercel --prod
```

---

## T+1h  First health check

Look at Vercel logs for the previous hour:

```bash
vercel logs --prod --since 1h | grep -E "\[zk-prover\]"
```

Expect to see lines like:
```
[zk-prover] role=primary backend=gpu status=200 elapsed=1843ms
[zk-prover] role=primary backend=shinami status=200 elapsed=842ms  # 75% of traffic
[zk-prover] role=fallback backend=shinami status=200 elapsed=890ms  # only on GPU fail
```

Pass criteria:
- Fallback rate < 1% of GPU primary calls (i.e. less than 1 in 100 GPU
  attempts ends up using Shinami as fallback).
- GPU p99 latency < 4s (well under our 30s budget).
- No 5xx burst on the GPU box (`ssh root@<IP> 'docker logs --tail 200
  zklogin-prover'`).

Rollback if fallback rate > 5% or p99 > 8s: same as T+15m rollback.

---

## T+12h  Bump canary to 50%

If still green:

```bash
cd /Users/eromonseleodigie/Talise/web
vercel env rm ZK_PROVER_CANARY_PCT production --yes
printf '50' | vercel env add ZK_PROVER_CANARY_PCT production
vercel --prod
```

Same observability as T+1h. Look at the next hour of logs.

Rollback: re-add as `0` or `25` and redeploy.

---

## T+24h  Flip PRIMARY to gpu (100%)

If 50% has been clean for 12+ hours:

```bash
cd /Users/eromonseleodigie/Talise/web
vercel env rm ZK_PROVER_PRIMARY production --yes
printf 'gpu' | vercel env add ZK_PROVER_PRIMARY production
vercel env rm ZK_PROVER_CANARY_PCT production --yes
printf '0' | vercel env add ZK_PROVER_CANARY_PCT production
vercel --prod
```

Now 100% of traffic goes to GPU first, Shinami is still the per-request
fallback. `CANARY_PCT=0` is correct here because PRIMARY=gpu means the
canary logic is bypassed — all traffic is GPU primary.

Rollback (instant):
```bash
vercel env rm ZK_PROVER_PRIMARY production --yes
printf 'shinami' | vercel env add ZK_PROVER_PRIMARY production
vercel --prod
```

---

## T+48h  Decommission (optional)

If you want to keep Shinami billed only on real GPU failures, leave
`ZK_PROVER_FALLBACK=shinami` as-is (belt-and-suspenders).

If you want to fully cut Shinami:

```bash
cd /Users/eromonseleodigie/Talise/web
vercel env rm ZK_PROVER_FALLBACK production --yes
printf 'none' | vercel env add ZK_PROVER_FALLBACK production
vercel --prod
```

Cancel the Shinami subscription only after 7+ days of `FALLBACK=none` with
no user-visible incidents.

Rollback (re-enable Shinami fallback):
```bash
vercel env rm ZK_PROVER_FALLBACK production --yes
printf 'shinami' | vercel env add ZK_PROVER_FALLBACK production
vercel --prod
```

---

## Emergency: GPU box is dead

If the GPU host goes down entirely (RunPod outage, kernel panic, OOM):

1. `ZK_PROVER_FALLBACK=shinami` (already true unless you removed it at T+48h)
   means every in-flight request auto-falls-back. No user-visible impact.
2. Flip primary back to shinami to stop wasting the first ~30s of every
   request waiting for the dead GPU:
   ```bash
   vercel env rm ZK_PROVER_PRIMARY production --yes
   printf 'shinami' | vercel env add ZK_PROVER_PRIMARY production
   vercel --prod
   ```
3. Investigate / rebuild the GPU box. Re-run the deploy script with the
   same `DOMAIN` to keep DNS pointing at the new IP after updating the A
   record.
