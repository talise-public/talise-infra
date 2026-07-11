# Deploy the Talise GPU zkLogin prover

One-page runbook to stand up the unconfirmedlabs GPU zkLogin prover, point
Vercel at it, and flip `ZK_PROVER_PRIMARY=gpu`. Total wall-clock: ~15 minutes
once you have a provider API key.

The Talise code path is already wired (`web/lib/zksigner.ts::callProverWithFallback`).
Shinami stays as the automatic fallback on any 5xx/timeout from the GPU box.

---

## 1. Pick a provider

| Provider | GPU | $/hr | $/mo | Notes |
| --- | --- | ---: | ---: | --- |
| **RunPod (default)** | NVIDIA L4 24GB | $0.44 | ~$317 | REST API, one curl spins up. **Recommended.** |
| RunPod | A10G 24GB | $0.65 | ~$468 | More public ICICLE-Snark validation data. |
| Lambda Labs | A10 24GB | $0.50 | ~$360 | Cheapest if you already have a Lambda account. |
| AWS | g6.xlarge (L4 24GB) | $0.81 | ~$583 | Best Vercel/iad1 colocation; 1yr reserved drops to ~$370/mo. |
| Fly.io | A100-40GB | $2.50 | ~$1,800 | DO NOT recommend. No L4 sku. |

**Default is RunPod L4** because the $/hr is lowest, signup-to-running is
under 10 minutes, and they don't require enterprise approval for GPU SKUs.

---

## 2. Get an API key, export it

### RunPod (recommended)
1. Sign up at https://runpod.io/console/user/settings
2. Add at least $10 in credits.
3. Settings → API Keys → Create (Read+Write).
4. ```bash
   export RUNPOD_API_KEY=...
   ```

### Lambda Labs
1. https://cloud.lambdalabs.com → add payment method.
2. API Keys → Generate.
3. Upload your SSH pubkey under SSH Keys (the deploy script reuses the first one).
4. ```bash
   export LAMBDA_LABS_API_KEY=...
   ```

### AWS
1. `aws configure` with credentials that can `ec2:RunInstances` on GPU SKUs in `us-east-1`.
2. ```bash
   export AWS_KEYPAIR_NAME=...   # existing EC2 key pair you can ssh with
   ```

---

## 3. Run the deploy script

```bash
bash infra/prover/gpu/deploy.sh --target=runpod
# or --target=lambda-labs / --target=aws
```

The script:

1. Provisions a GPU instance.
2. SSHes in and runs a bootstrap script that:
   - Installs Docker + NVIDIA Container Toolkit + Caddy.
   - Fetches `zkLogin-main.zkey` (~700MB) from Mysten's ceremony repo via
     git-lfs and verifies the Blake2b hash
     (`060beb9618…bcbcbce`).
   - Logs in to ghcr.io (optional, only needed if you mark the package private).
   - Pulls `ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1` and runs
     it with `--gpus all` on `127.0.0.1:8080`.
   - Writes a Caddyfile that reverse-proxies `${DOMAIN}` → `127.0.0.1:8080`
     and ACME-issues a Let's Encrypt cert.
3. Prints the public IP.

---

## 4. Point DNS at the new IP

The script prints something like:

```
Point DNS A record:  zk-prover.talise.io  ->  72.103.44.18
```

In your DNS provider (Cloudflare/Route53/etc.), set an A record for
`zk-prover.talise.io` pointing to that IP. **Disable proxy/CDN** (set
Cloudflare to "DNS Only", grey cloud) — Caddy needs direct TCP from
Let's Encrypt for the HTTP-01 challenge.

Wait 1–2 minutes for propagation, then:

```bash
curl https://zk-prover.talise.io/healthz
```

Should return 200 with a JSON body. If you get a TLS error, Caddy is still
fetching the cert — wait another minute.

---

## 5. Smoke-test the wire format

```bash
bash infra/prover/gpu/smoke.sh https://zk-prover.talise.io
```

Validates:
- `/healthz` returns 200.
- `/warmup` accepts a POST and returns 200.
- (If you pipe a real zkLogin circuit input on stdin) response body matches
  `normalizeProverResponse()` in `web/lib/zksigner.ts` — either camelCase
  (`proofPoints`/`issBase64Details`/`headerBase64`) or snake_case variants.

Exit 0 = safe to cut over. Exit 1 = read the diagnostic, do not flip.

---

## 6. Wire Vercel + canary

The Talise prover URL convention is **base URL + `/input`** because
`callProver()` in `web/lib/zksigner.ts` POSTs directly to the URL with no
path appended.

```bash
# CANARY first (25% of users → GPU, 75% → Shinami):
vercel env add ZK_PROVER_GPU_URL production
# paste: https://zk-prover.talise.io/input

vercel env add ZK_PROVER_CANARY_PCT production
# paste: 25

vercel --prod
```

Watch Vercel logs for `[zk-prover]` lines:

```
[zk-prover] role=primary backend=gpu attempt=1 status=200 ms=412
[zk-prover] role=primary backend=shinami attempt=1 status=200 ms=2740
```

Look for: GPU `ms` < 1500, no `role=fallback` lines in steady state.
Bake at 25% for 24h, then ramp to 50% / 100%.

When you're confident, flip primary fully:

```bash
vercel env rm ZK_PROVER_CANARY_PCT production
vercel env add ZK_PROVER_PRIMARY production
# paste: gpu
vercel --prod
```

`ZK_PROVER_FALLBACK` defaults to `shinami`, so Shinami still backstops any
GPU 5xx/timeout.

---

## 7. Things to check BEFORE running `deploy-gpu-prover.sh`

1. **`ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1` exists and is
   public.** The local Docker build was skipped (the build host has no GPU
   and limited disk). The bootstrap script as shipped tries to pull this
   tag — you have two options:
   - **(a) Build + push from the GPU box.** SSH in after step 3 provisions
     it, `git clone https://github.com/unconfirmedlabs/sui-zklogin-gpu-prover`,
     `docker build -f docker/icicle-cuda/Dockerfile -t sui-zklogin-icicle-cuda:upstream .`,
     then `docker build -f Dockerfile.talise -t ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1 .`
     using the Dockerfile.talise wrapper in this repo. Then `gh auth token | docker login ghcr.io --password-stdin` and push.
   - **(b) Skip the wrapper** for the first deploy: edit
     `infra/prover/gpu/deploy.sh` and set `IMAGE=sui-zklogin-icicle-cuda:upstream`
     after building the upstream image locally on the GPU box. You lose the
     tini PID-1 wrapper and the Docker HEALTHCHECK, but it works.

2. **DNS for `zk-prover.talise.io` is yours to set.** If you don't control
   the DNS, change `DOMAIN=…` when calling the script and use a domain you
   do control. Let's Encrypt won't issue a cert for a name you can't prove
   control over.

3. **Provider quota.** RunPod sometimes runs out of L4 capacity in a
   region — re-run with `GPU_TYPE='NVIDIA A10'` if the GraphQL call returns
   "no capacity". AWS will refuse `g6.xlarge` on a new account; if so, file
   a service-quota increase for "Running On-Demand G and VT instances" or
   pick a different provider.

---

## 8. Tear-down

```bash
# RunPod: pod ID was printed at deploy time
curl -X POST https://api.runpod.io/graphql \
  -H "Authorization: Bearer $RUNPOD_API_KEY" \
  -d '{"query":"mutation { podTerminate(input:{podId:\"POD_ID\"}) }"}'

# AWS:
aws ec2 terminate-instances --instance-ids i-xxxx

# Lambda Labs:
curl -u "$LAMBDA_LABS_API_KEY:" \
  -X POST https://cloud.lambdalabs.com/api/v1/instance-operations/terminate \
  -H 'content-type: application/json' \
  -d '{"instance_ids":["i-xxxx"]}'
```

Set `ZK_PROVER_PRIMARY=shinami` in Vercel before tearing down so user traffic
doesn't slam a fallback path.

---

## 9. References

- Upstream prover repo: https://github.com/unconfirmedlabs/sui-zklogin-gpu-prover
- zkLogin ceremony zkey source: https://github.com/sui-foundation/zklogin-ceremony-contributions
- Talise rollout/canary code: `web/lib/zksigner.ts::callProverWithFallback`
- Full operations notes: `infra/prover/gpu/RUNBOOK.md`
