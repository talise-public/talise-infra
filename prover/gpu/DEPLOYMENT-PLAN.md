# GPU Prover Deployment Plan

**Status:** Draft
**Owner:** Infra
**Target image:** `ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1`
**Target host:** RunPod L4 (24GB) at `zk-prover.talise.io`
**Traffic posture at T+0:** 0% (PRIMARY=shinami, FALLBACK=shinami, CANARY_PCT=0). No user-visible change until the canary flip.

---

## 1. Context

The zkLogin proof is 99.9% of total signing latency. Shinami (default) sits at 2-4s p50. The unconfirmedlabs GPU prover lands at ~400ms warm on a single L4. Cutover to the GPU prover is gated behind a canary in `web/lib/zksigner.ts` so we can route 0% / 25% / 50% / 100% by toggling one env var.

Everything required on the application side (canary, fallback, snake_case-tolerant response normalizer, smoke script, babysit playbook) is already shipped. The only blocker is **publishing the Docker image to a registry the GPU host can pull from**.

---

## 2. Why the image cannot be built on the dev Mac

Three independent constraints, each sufficient on its own.

1. **Architecture mismatch.** Mac is `darwin/arm64`. Image is `linux/amd64`. Local build forces QEMU emulation: amd64 instructions translated one at a time on arm64 silicon. Rust + rapidsnark + icicle-snark compile under emulation runs 10-20x slower than native. Measured cost: ~90 min for base-layer pulls alone, hours more for the compile.

2. **No CUDA at runtime.** The prover needs an NVIDIA GPU. Apple Silicon ships Metal, not NVIDIA. Docker Desktop on Mac has zero CUDA passthrough. Even a successful build cannot run locally; `docker run` would die at `cuda_init`. This is structural, not a tooling gap.

3. **Base layers are huge.** `nvidia/cuda:12.9.1-devel-ubuntu24.04` is 3.24 GB; the CUDNN layer adds 2.30 GB. At observed ~1 MB/s on the dev link, that is >1.5 hours just to fetch before compile.

Conclusion: this is a **build-on-the-deployment-target** workload by nature. The dev Mac is the wrong build host.

---

## 3. Three viable paths to a runnable image

### Path A — GitHub Actions cross-build (recommended)

Free `ubuntu-latest` runners are native amd64. No emulation. Build runs in 15-20 min. Image is pushed to GHCR. Every subsequent provision is a 30s `docker pull`.

**One-time setup (~20 min):**

```bash
mkdir -p .github/workflows
# Create .github/workflows/build-gpu-prover.yml — content in section 6.
git add .github/workflows/build-gpu-prover.yml
git commit -m "ci: cross-build sui-zklogin-gpu-prover on Actions"
git push
```

**Run it:**

```bash
gh workflow run build-gpu-prover.yml
gh run watch
```

**Make the package public** (one-time, manual):

```
https://github.com/SeventhOdyssey71?tab=packages
  → sui-zklogin-gpu-prover
  → Package settings
  → Change visibility → Public
```

**Verify:**

```bash
docker pull ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1
docker manifest inspect ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1 | grep architecture
# expect: "architecture": "amd64"
```

**Pros:** image survives box churn, deploys are fast, reproducible, cached.
**Cons:** one-time YAML + visibility flip.

---

### Path B — Build on the GPU host itself (one-shot)

After RunPod provisions the box, SSH in and build there. Host is amd64 native, has the GPU on hand, build runs in ~20 min on an L4.

```bash
# After deploy-gpu-prover.sh prints the public IP
ssh -i ~/.ssh/talise-zklogin root@<IP>

# On the box:
cd /tmp
git clone https://github.com/unconfirmedlabs/sui-zklogin-gpu-prover.git
cd sui-zklogin-gpu-prover
docker build -f docker/icicle-cuda/Dockerfile \
  -t ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1 .

docker run -d --gpus all --restart unless-stopped \
  -p 80:8080 --name prover \
  ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1
```

**Pros:** zero CI setup, fastest path to a running prover today.
**Cons:** image lives on one box. If the box dies, the next provision is another 20-min build. No registry of record.

---

### Path C — Patch bootstrap to build inline on every boot

Edit `infra/prover/gpu/deploy.sh` so the cloud-init userdata does `git clone + docker build` before `docker run` instead of `docker pull`. Every fresh box does its own 20-min build.

In the bootstrap section, replace:

```bash
docker pull "$IMAGE"
```

with:

```bash
cd /tmp
git clone https://github.com/unconfirmedlabs/sui-zklogin-gpu-prover.git prover
cd prover
docker build -f docker/icicle-cuda/Dockerfile -t "$IMAGE" .
```

**Pros:** no Actions, no GHCR.
**Cons:** every provision pays 20 min. No image of record. Diverges from the dry-run playbook.

---

## 4. Recommended order

1. **Do Path A.** 20 min of YAML work buys 30-second deploys from then on. This is the load-bearing decision.
2. **If you need a prover up today and Path A is blocked,** do Path B as a one-shot. Plan to backfill Path A within the week so future boxes do not require a fresh build.
3. **Skip Path C** unless you will churn boxes without keeping GHCR in sync (rare).

---

## 5. Decision matrix

| Criterion              | Path A (Actions)         | Path B (host build)         | Path C (inline)            |
| ---------------------- | ------------------------ | --------------------------- | -------------------------- |
| Setup time             | ~20 min YAML, once       | 0                           | ~10 min patch              |
| First image available  | ~20 min after merge      | ~20 min after SSH           | ~20 min into first boot    |
| Each new box           | 30 s pull                | 20 min (rebuild)            | 20 min (rebuild)           |
| Survives box loss      | yes                      | no                          | yes (rebuilds itself)      |
| Reproducible           | yes (commit-pinned)      | sort of                     | yes                        |
| GHCR registry of record| yes                      | no                          | no                         |
| Cost                   | free (Actions minutes)   | 20 min of GPU time per box  | 20 min of GPU time per box |

---

## 6. Path A — exact workflow YAML

Drop this file at `.github/workflows/build-gpu-prover.yml`:

```yaml
name: Build GPU Prover
on:
  workflow_dispatch:
  push:
    paths:
      - '.github/workflows/build-gpu-prover.yml'

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
        with:
          repository: unconfirmedlabs/sui-zklogin-gpu-prover
          path: prover

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v5
        with:
          context: ./prover
          file: ./prover/docker/icicle-cuda/Dockerfile
          platforms: linux/amd64
          push: true
          tags: ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

Notes:

* `workflow_dispatch` lets you re-run on demand from the Actions tab or `gh workflow run`.
* GHA cache (`type=gha`) makes the second build ~5 min if upstream did not change layers.
* Image tag is pinned to `:v1`. Bump to `:v2` when upstream cuts a meaningful release; keep the bootstrap script in sync.
* Permissions block is required for the workflow token to push to GHCR.

---

## 7. End-to-end deploy runbook (after image is published)

This is the production cutover sequence. Each step is recoverable by toggling one env var.

### T+0 — Provision the GPU box

```bash
export RUNPOD_API_KEY=...
bash infra/prover/gpu/deploy.sh --target=runpod
# script prints: public IP, SSH key path, expected boot time
```

Sanity check the bootstrap pulled the image:

```bash
ssh -i <key> root@<IP> 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"'
# expect: prover ... ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1
```

### T+5m — Point DNS

In Cloudflare:

* A record: `zk-prover.talise.io` → `<public IP>`, proxied = OFF (Cloudflare will not proxy raw TCP to a non-standard health path cleanly; keep it grey for the first cutover).
* TTL: 60s.

Wait ~2 minutes for propagation.

### T+10m — Smoke test

```bash
bash infra/prover/gpu/smoke.sh https://zk-prover.talise.io
# validates /healthz returns 200, /input accepts the canonical envelope,
# response shape passes normalizeProverResponse() in zksigner.ts.
```

If smoke fails, do not proceed. Roll back per section 8.

### T+15m — Wire Vercel at 25% canary

```bash
cd web
printf 'https://zk-prover.talise.io/input' | vercel env add ZK_PROVER_GPU_URL production
vercel env rm ZK_PROVER_CANARY_PCT production --yes
printf '25' | vercel env add ZK_PROVER_CANARY_PCT production
vercel --prod
```

At this point 25% of zkLogin proof requests route to GPU. PRIMARY is still `shinami`, so on any error the request falls back. User-visible failure rate should not change.

### T+1h — First checkpoint

* Vercel logs: search for `zk-prover.talise.io` and confirm 200s with reasonable latency.
* GPU box: `ssh ... 'docker logs prover --tail 200 | grep -E "(ERROR|panic)"'` — expect empty.
* Application: spot-check sign-in latency in production. Should be lower for the 25% bucket.

### T+12h — 50% canary

```bash
cd web
vercel env rm ZK_PROVER_CANARY_PCT production --yes
printf '50' | vercel env add ZK_PROVER_CANARY_PCT production
vercel --prod
```

### T+24h — Flip PRIMARY to GPU

```bash
cd web
vercel env rm ZK_PROVER_PRIMARY production --yes
printf 'gpu' | vercel env add ZK_PROVER_PRIMARY production
# FALLBACK stays shinami. CANARY_PCT is now ignored when PRIMARY=gpu.
vercel --prod
```

100% of traffic is on GPU. Shinami is the safety net.

### T+48h — Optional Shinami decommission

If GPU has been clean for 48h, you can drop Shinami billing:

```bash
cd web
vercel env rm ZK_PROVER_FALLBACK production --yes
printf 'none' | vercel env add ZK_PROVER_FALLBACK production
vercel --prod
```

This is reversible. Do not do it until you are confident.

---

## 8. Rollback

Every stage has a one-env-var rollback. Recovery time is the Vercel redeploy time (~3 min).

| Stage          | Symptom                       | Rollback                                                                 |
| -------------- | ----------------------------- | ------------------------------------------------------------------------ |
| T+5 to T+15    | DNS or smoke fails            | Do not proceed. Box still costs money; either fix or `runpod stop`.       |
| T+15 (canary)  | Error rate up                 | `vercel env rm ZK_PROVER_CANARY_PCT && printf 0 \| vercel env add ZK_PROVER_CANARY_PCT production && vercel --prod` |
| T+24 (PRIMARY) | GPU box down                  | `vercel env rm ZK_PROVER_PRIMARY && printf shinami \| vercel env add ZK_PROVER_PRIMARY production && vercel --prod` |
| T+48 (no fallback) | GPU box down              | Re-add `ZK_PROVER_FALLBACK=shinami` and redeploy.                         |
| Box completely dead | All proofs failing       | `ZK_PROVER_PRIMARY=shinami`, ignore the box, debug at leisure.            |

Detail playbook with exact commands: `infra/prover/gpu/BABYSIT.md`.

---

## 9. Verification checklist

Before promoting beyond 25% canary, confirm all of:

* [ ] `docker manifest inspect ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1` shows `linux/amd64`.
* [ ] Package visibility on GHCR is **Public** (otherwise the bootstrap pull on a fresh box will 401).
* [ ] `bash infra/prover/gpu/smoke.sh https://zk-prover.talise.io` exits 0.
* [ ] Vercel production env shows `ZK_PROVER_GPU_URL`, `ZK_PROVER_PRIMARY`, `ZK_PROVER_FALLBACK`, `ZK_PROVER_CANARY_PCT` populated and the deploy that consumed them is current.
* [ ] `web/lib/zksigner.ts` is at or past commit `f00cd6b` (canary code shipped).
* [ ] One real zkLogin sign-in from the production app succeeds end-to-end while canary is at 25%.

---

## 10. Open items

* **Buy a backup region.** RunPod L4 is single-region. If that region goes down, traffic falls back to Shinami automatically, but latency reverts to 2-4s. A second box in a different region with a weighted DNS record removes that single point of failure. Defer until volume justifies (~10k proofs/day).
* **Bump to multi-arch publish.** Currently building amd64 only. Not relevant for production (no arm64 GPU hosts on RunPod/Lambda/AWS for our SKUs), but worth knowing if the prover ever runs on Graviton.
* **CI for upstream changes.** Path A only rebuilds when the workflow file changes. If unconfirmedlabs ships a fix, we will not pick it up automatically. Add a weekly `schedule:` trigger if drift becomes a problem.
* **Cost ceiling.** L4 on RunPod is ~$0.44/hr, ~$317/mo. Document the kill criteria: if volume drops below some threshold, flip back to Shinami and stop the box.

---

## 11. Owner actions, today

1. Decide between Path A and Path B (recommend A).
2. If A: create the workflow file (section 6), commit, push, run, flip GHCR to public.
3. If B: have RunPod API key ready, plan a 30-min uninterrupted window for SSH + build.
4. Either way: do not flip `ZK_PROVER_PRIMARY=gpu` until the 25% canary has run clean for at least 1h.
