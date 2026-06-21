# zkLogin GPU Prover — Production Runbook

_Companion to `docs/security/ZKLOGIN-PROVER-COMPARISON.md` (technical analysis) and
`docs/security/ZKLOGIN-PROVER-INTEGRATION-PLAN.md` (rollout plan). This doc is **operations**
— how to actually stand up the unconfirmedlabs GPU prover for Talise._

**Why GPU at all?** Talise's Google OAuth audience is **not whitelisted** on
Mysten's mainnet hosted prover (the reason we ended up on Shinami). The
choices are: (a) stay on Shinami (2–4s, 2/min rate limit), (b) get whitelisted
(blocked on Mysten), or (c) self-host. This runbook covers (c) using the
`unconfirmedlabs/sui-zklogin-gpu-prover` HTTP service, with **Shinami as the
automatic fallback** for the first 30 days post-cutover.

**Status of the code path:** the runtime toggle is already shipped — see
`web/lib/zksigner.ts:callProverWithFallback`. The code defaults to Shinami;
this runbook is the prerequisite for flipping `ZK_PROVER_PRIMARY=gpu`.

---

## a) Hardware target

**Production baseline: AWS `g6.xlarge` (us-east-1).**

| spec        | value                                                |
| ----------- | ---------------------------------------------------- |
| GPU         | 1× NVIDIA L4 (Ada Lovelace, 24 GB GDDR6, ECC)        |
| vCPU / RAM  | 4 vCPU / 16 GB RAM                                   |
| storage     | gp3 EBS, 100 GB (zkey is ~700 MB, leave headroom)    |
| On-demand   | $0.8048/hr us-east-1 = ~$580/month                   |
| 1yr reserved| ~$370/month (save ~36% — buy after 30-day burn-in)   |

**Alternative: `g5.xlarge` (A10G, 24 GB GDDR6).** ~$1.00/hr = ~$720/month.
Slightly more public benchmark data exists for A10G with ICICLE-Snark
(it's the older silicon), so this is the safer pick if `g6.xlarge` shows
issues during burn-in. **Do not pick `g4dn.*`** — T4 GPUs lack the FP32
throughput for sub-500ms warm proofs at our circuit size.

**Why not H100/p5?** Overkill. H100 cuts warm proof core to ~110ms but
Talise's bottleneck is witness gen (~250ms CPU-side) and payload conversion,
which H100 doesn't accelerate. p5 instances also start at >$3/hr — not worth
the >5x cost for ~50ms saved.

**Region:** `us-east-1`. Two reasons: (1) lowest latency to Vercel's iad1
region where our API routes execute, (2) widest GPU instance availability.
**[VERIFY]** the actual Vercel region your project deploys to — see
`vercel.json` or the Vercel dashboard — and colocate.

**Provision count:** **1** for the first 30 days. Single point of failure is
mitigated by the Shinami fallback in `callProverWithFallback`. Move to 2
replicas behind ALB only when (a) Shinami fallback fires >1×/day for a week,
or (b) sustained traffic crosses ~50 proofs/min.

---

## b) Container image

The unconfirmedlabs repo ships a Dockerfile for both CPU (`rapidsnark-cpu`)
and GPU (`icicle-cuda`) backends. No image is published to Docker Hub at the
time of writing — **we build from source and push to our own ECR**.

**Pin point.** `commit 249c2f8` (last push 2026-05-19, per the comparison
doc). **[VERIFY]** the latest commit before building — if it's been more
than 90 days since this runbook was last touched, walk the diff before
rebuilding.

**Build steps** (on a CUDA-capable build host; AWS Deep Learning AMI ok):

```bash
# 1. Clone, pin commit
git clone https://github.com/unconfirmedlabs/sui-zklogin-gpu-prover.git
cd sui-zklogin-gpu-prover
git checkout 249c2f8   # [VERIFY against latest]

# 2. Build the GPU image. Base: nvidia/cuda:12.9.1-base-ubuntu24.04
docker build \
  -f Dockerfile.gpu \
  --build-arg BACKEND=icicle-cuda \
  -t talise/zklogin-prover-gpu:249c2f8 \
  .

# 3. Tag for ECR and push
aws ecr create-repository --repository-name talise/zklogin-prover-gpu --region us-east-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR=$ACCOUNT.dkr.ecr.us-east-1.amazonaws.com
docker tag talise/zklogin-prover-gpu:249c2f8 $ECR/talise/zklogin-prover-gpu:249c2f8
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin $ECR
docker push $ECR/talise/zklogin-prover-gpu:249c2f8
```

**Verify the base image** matches our CUDA driver on the host:
```bash
docker run --rm --gpus all nvidia/cuda:12.9.1-base-ubuntu24.04 nvidia-smi
```
If this fails, the driver on the host is < 555 (CUDA 12.9 requires
`>= 555.42`). Install the AWS Deep Learning AMI **Ubuntu 22.04 (PyTorch 2.x)**
or a custom Ubuntu with `nvidia-driver-555-server` installed.

---

## c) Proving key

The unconfirmedlabs prover **expects the official Sui ceremony zkey** —
`zkLogin-main.zkey`, ~700 MB. The chain-of-trust is preserved: same key
Mysten ships, just a different prover binary.

**Source of truth.** The Sui Foundation hosts the zkey at the URL in the
Sui docs zklogin-integration page:
- Primary: `https://docs.sui.io/guides/developer/cryptography/zklogin-integration`
  (search for "proving key" — the canonical S3/CloudFront URL is linked there)
- Mirror inside the unconfirmedlabs repo: `scripts/download-zkey.sh` (it
  curls the same canonical URL — do not blindly trust the script, read it).

**Verify the hash before mounting** — this is non-negotiable, the zkey is
the cryptographic root of trust:

```bash
# Expected SHA-256: [VERIFY] copy the published hash from
# https://docs.sui.io/guides/developer/cryptography/zklogin-integration
# Talise as of 2026-05: <fill in hex when downloading>
EXPECTED_SHA="<paste hex from Sui docs>"

curl -fL -o zkLogin-main.zkey "https://<url-from-sui-docs>"
echo "${EXPECTED_SHA}  zkLogin-main.zkey" | sha256sum -c
# MUST print: zkLogin-main.zkey: OK
```

**Mount strategy.** Bake into the image OR mount via EBS. We mount via EBS:
- separate `gp3` 10 GB volume, mounted read-only at `/srv/zklogin/zkey`
- container envs: `ZKEY_PATH=/srv/zklogin/zkey/zkLogin-main.zkey`
- read-only mount supported per the 2026-05-19 commit
  ("Support read-only zkey mounts")

Cold-load of the zkey into VRAM takes ~13s on first request (per comparison
doc §3). To avoid the first end-user paying this, run the smoke test in §j
immediately after deploy to warm the worker.

---

## d) Deployment — ECS-on-EC2-GPU

**Why not Fargate?** Fargate does not support GPU workloads as of 2026.
**Why not bare EC2 + systemd?** ECS gives us free task health checks, log
shipping to CloudWatch, and easier multi-replica scale-out later.
**Why not EKS?** Overkill for one container.

### Topology

```
Vercel (iad1)
  │  HTTPS
  ▼
ALB (us-east-1, public)
  │  forwards to target group (port 8080)
  ▼
ECS Service "zk-prover" (1 task, on EC2 GPU capacity)
  │
  ▼
g6.xlarge EC2 in private subnet
  - ECS-optimized GPU AMI (Amazon Linux 2023 GPU + nvidia-docker)
  - container: talise/zklogin-prover-gpu:249c2f8
  - mounts: zkey EBS (read-only)
```

### Step-by-step (raw AWS CLI flavor — convert to Terraform/CDK in your IaC repo)

```bash
# 1. Cluster
aws ecs create-cluster --cluster-name talise-zk-prover

# 2. ECS-optimized GPU AMI + Launch Template
AMI=$(aws ssm get-parameter \
  --name /aws/service/ecs/optimized-ami/amazon-linux-2023/gpu/recommended \
  --query 'Parameter.Value' --output text \
  | jq -r '.image_id')

aws ec2 create-launch-template \
  --launch-template-name talise-zk-prover-lt \
  --launch-template-data "{
    \"ImageId\": \"$AMI\",
    \"InstanceType\": \"g6.xlarge\",
    \"IamInstanceProfile\": {\"Name\": \"ecsInstanceRole\"},
    \"SecurityGroupIds\": [\"sg-xxxxxx\"],
    \"UserData\": \"$(echo -n '#!/bin/bash
echo ECS_CLUSTER=talise-zk-prover >> /etc/ecs/ecs.config
echo ECS_ENABLE_GPU_SUPPORT=true >> /etc/ecs/ecs.config' | base64 -w0)\"
  }"

# 3. Auto Scaling Group (desired=1, max=2 for future)
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name talise-zk-prover-asg \
  --launch-template "LaunchTemplateName=talise-zk-prover-lt,Version=1" \
  --min-size 1 --max-size 2 --desired-capacity 1 \
  --vpc-zone-identifier "subnet-xxxx,subnet-yyyy"

# 4. ECS capacity provider linked to ASG (so ECS can place GPU tasks)
aws ecs create-capacity-provider \
  --name talise-zk-prover-cp \
  --auto-scaling-group-provider "autoScalingGroupArn=...,managedScaling={status=ENABLED,targetCapacity=100}"

aws ecs put-cluster-capacity-providers \
  --cluster talise-zk-prover \
  --capacity-providers talise-zk-prover-cp \
  --default-capacity-provider-strategy capacityProvider=talise-zk-prover-cp,weight=1

# 5. Task definition (GPU resource requirement is critical)
cat > task-def.json <<'EOF'
{
  "family": "zk-prover-gpu",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["EC2"],
  "cpu": "3072",
  "memory": "12288",
  "containerDefinitions": [{
    "name": "prover",
    "image": "ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/talise/zklogin-prover-gpu:249c2f8",
    "portMappings": [{"containerPort": 8080, "protocol": "tcp"}],
    "resourceRequirements": [
      {"type": "GPU", "value": "1"}
    ],
    "environment": [
      {"name": "ZKEY_PATH", "value": "/srv/zklogin/zkey/zkLogin-main.zkey"},
      {"name": "PROVER_BACKENDS", "value": "gpu,cpu"},
      {"name": "GPU_PROOF_WORKERS", "value": "1"},
      {"name": "BIND_ADDR", "value": "0.0.0.0:8080"}
    ],
    "mountPoints": [
      {"containerPath": "/srv/zklogin/zkey", "sourceVolume": "zkey", "readOnly": true}
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/zk-prover-gpu",
        "awslogs-region": "us-east-1",
        "awslogs-stream-prefix": "prover"
      }
    },
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"],
      "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 60
    }
  }],
  "volumes": [
    {"name": "zkey", "host": {"sourcePath": "/srv/zklogin/zkey"}}
  ]
}
EOF
aws ecs register-task-definition --cli-input-json file://task-def.json

# 6. Service behind ALB target group (created in §e below)
aws ecs create-service \
  --cluster talise-zk-prover \
  --service-name zk-prover \
  --task-definition zk-prover-gpu \
  --desired-count 1 \
  --launch-type EC2 \
  --load-balancers "targetGroupArn=arn:aws:...,containerName=prover,containerPort=8080" \
  --health-check-grace-period-seconds 90
```

**EBS zkey volume** is mounted on the EC2 host at `/srv/zklogin/zkey` via a
one-shot bootstrap script. Bake into the AMI or run via `cloud-init`.

---

## e) Networking

```
zk-prover.talise.io
  ↳ ACM cert (us-east-1, wildcard *.talise.io or specific)
  ↳ Route 53 ALIAS  →  ALB (internet-facing, 2 AZs)
  ↳ ALB listener :443 (HTTPS, ACM cert)
  ↳ ALB listener :80  (HTTP, redirect to :443)
  ↳ Target group :8080 (HTTP, health check /health, interval 30s)
```

### Auth — pick ONE of:

**Option A: shared-secret header (recommended for first 30 days).**
Vercel sends `Authorization: Bearer ${ZK_PROVER_AUTH_TOKEN}`; the
prover sidecar (a tiny Express/Caddy in front, or an ALB Lambda auth) checks
it. Failure mode: simple, no IP allowlist drift when Vercel rotates egress
IPs. **Adds ~3 lines to `callProver()` if/when we enable it** — extend the
`opts.headers` plumbing in `web/lib/zksigner.ts:callProver`.

**Option B: Vercel egress IP allowlist on the security group.** Vercel
publishes its egress IPs at `https://vercel.com/docs/edge-network/regions`
**[VERIFY current list at deploy time]**. Tighter posture, but fragile —
Vercel adds/removes IPs and our prover blackholes silently.

Recommend **A** for the cutover, then layer **B** on top once stable.

### Security group rules

```
Inbound (sg-prover):
  - tcp/443 from sg-alb     (alb → prover via target group on 8080 — adjust)
  - tcp/8080 from sg-alb
  - tcp/22 from bastion-sg  (ops only)
Outbound:
  - tcp/443 to 0.0.0.0/0    (ECR pull, CloudWatch logs)
```

### CloudFront in front? **No.** The prover doesn't benefit from edge caching
(every proof is unique). Direct ALB is simpler and one fewer hop.

---

## f) Health check

The unconfirmedlabs prover exposes `GET /health` (per the comparison doc
mentioning "healthz/metrics endpoints"). **[VERIFY exact path]** — if it's
`/healthz`, update the task-def health check accordingly.

```bash
# Liveness: ALB target group health check (configured above)
GET /health → 200 OK

# Readiness (zkey loaded into VRAM): synthetic proof every 5 min
# CloudWatch Synthetics canary runs the script below; alerts on > 800ms or non-200.
```

**Synthetic proof canary.** Run a real prove request every 5 minutes with a
fixed test JWT (rotate weekly — Google JWTs expire in 1h, so this needs to
be a long-lived service-account-signed JWT from our own RSA keypair OR a
rotating fresh Google token from a CI cron). Records:
- `proof.latency.ms`
- `proof.http.status`
- `proof.gpu.utilization.pct` (scrape from `/metrics`)

Set CloudWatch alarms:
- p95 latency > 1500ms for 3 consecutive runs → page (PagerDuty / OpsGenie)
- 5xx error in 2 consecutive runs → page
- /health 5xx for 1 run → warn

---

## g) Observability

### Container-level

The prover emits **Server-Timing response headers** (per comparison doc) —
forward those into CloudWatch via an Envoy/Caddy sidecar, or parse them in
the ALB access logs.

Per-request log line we want (add via a tiny request-id middleware if the
prover doesn't already emit it):
```
ts=2026-05-26T14:32:11Z req_id=abc123 user_addr_hash=xx ms_total=412 ms_witness=259 ms_proof=142 backend=gpu status=200
```

### Infra

CloudWatch Container Insights enabled on the cluster:
- `GPUUtilization` (custom metric — DCGM exporter sidecar; package
  `nvidia-dcgm-exporter`)
- `GPUMemoryUtilization`
- `MemoryUtilization` (host)
- `CPUUtilization` (host)
- ALB: `RequestCount`, `TargetResponseTime`, `HTTPCode_Target_5XX_Count`,
  `HTTPCode_Target_4XX_Count`

### Vercel side

The Vercel logs already include the `[zk-prover] role=… backend=… status=…
ms=…` line from `callProverWithFallback`. Pipe via Vercel's log drain into
DataDog/Axiom (whatever Talise uses) and dashboard:
- p50/p90/p99 `ms` by `backend`
- fallback rate (count where `role=fallback`) — should be < 1% steady-state
- per-attempt status code histogram

### Alarms to wire

| condition                                         | severity | action          |
| ------------------------------------------------- | -------- | --------------- |
| `[zk-prover] role=fallback` rate > 1% / 5min      | page     | investigate GPU |
| GPUUtilization == 0 for > 5min (with traffic)     | page     | container hung  |
| ALB 5xx > 1% / 5min                               | page     | rollback        |
| EC2 `StatusCheckFailed` == 1                      | page     | replace host    |
| AWS Budget actual > $750/month                    | warn     | cost review     |

---

## h) Rollback

**Fastest path (3 minutes, no AWS interaction):**

1. Open Vercel dashboard → Talise project → Settings → Environment Variables.
2. Set `ZK_PROVER_PRIMARY=shinami`. Leave `ZK_PROVER_FALLBACK=shinami`
   (this becomes a no-op since primary already is).
3. Trigger redeploy (or use `vercel env pull` + a deploy from CLI).
4. Confirm in Vercel logs: `[zk-prover] role=primary backend=shinami …`

**Leave the GPU box up.** Useful for postmortem — preserve the failing
container's logs/state. Tear down only after RCA.

**Cancel canary specifically** (don't flip primary, just stop the GPU
opt-in trickle): set `ZK_PROVER_CANARY_PCT=0`. Same 3-minute redeploy.

**Full teardown** (after RCA, when truly walking away):
```bash
aws ecs update-service --cluster talise-zk-prover --service zk-prover --desired-count 0
aws autoscaling update-auto-scaling-group --auto-scaling-group-name talise-zk-prover-asg --min-size 0 --desired-capacity 0
# Wait for instance to terminate, then:
aws ecs delete-service --cluster talise-zk-prover --service zk-prover --force
aws ecs delete-cluster --cluster talise-zk-prover
# ALB, target group, EBS zkey volume left in place until billing review.
```

---

## i) Cost guardrails

### Budget

AWS Budgets:
- **Actual budget** at $600/month — informational notification
- **Forecasted budget** at $750/month — page (this catches an accidental
  upsize to `g6.4xlarge` early in the month)

```bash
aws budgets create-budget --account-id $ACCOUNT \
  --budget '{"BudgetName":"talise-zk-prover","BudgetLimit":{"Amount":"750","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers file://budget-notifs.json
```

### Auto-stop script

Triggered by the $750 forecast alarm via SNS → Lambda:

```python
# auto-stop-if-overbudget.py
import boto3, os
ecs = boto3.client('ecs')
asg = boto3.client('autoscaling')
def handler(event, context):
    ecs.update_service(cluster='talise-zk-prover', service='zk-prover', desiredCount=0)
    asg.update_auto_scaling_group(AutoScalingGroupName='talise-zk-prover-asg',
                                  MinSize=0, DesiredCapacity=0)
    # Flip Vercel back to Shinami — Vercel deploy hook
    import urllib.request, json
    req = urllib.request.Request(
        os.environ['VERCEL_DEPLOY_HOOK_URL'], method='POST',
        data=json.dumps({"env":{"ZK_PROVER_PRIMARY":"shinami"}}).encode())
    urllib.request.urlopen(req)
```

Pair the Lambda with a Slack webhook so on-call sees the auto-stop fire.

### Reserved instance

After 30 days of stable utilization, buy a **1yr standard RI** for the
`g6.xlarge` — saves ~36% (≈$210/month). Don't buy on day 1 because rollback
needs to be cheap.

---

## j) Smoke tests

Run in order. **Don't flip `ZK_PROVER_PRIMARY=gpu` in production until ALL
three pass.**

### 1. Health probe

```bash
curl -fsS https://zk-prover.talise.io/health
# Expected: 200 OK, body like {"status":"ready","zkey_loaded":true,"gpu":"NVIDIA L4"}
```

### 2. Speed-test harness (the canonical benchmark)

The speed-test now accepts `--prover-url`:

```bash
cd web
ZK_TEST_JWT=<fresh Google JWT> pnpm node scripts/zk-speed-test.mjs \
  --prover-url=https://zk-prover.talise.io/v1 \
  --mode=gpu
```

**Expected prover RT (warm):**
| stat | target  | notes                                  |
| ---- | ------- | -------------------------------------- |
| min  | 350 ms  | first iteration may be cold (~3-15s)   |
| p50  | 400–800 ms | the headline win                    |
| p90  | < 1000 ms |                                      |
| p99  | < 1500 ms |                                      |

If p50 is > 800 ms, GPU is contended or the L4 is bandwidth-bound — escalate
to `g5.xlarge` (A10G) and re-test. **[VERIFY]** the exact L4 numbers — the
comparison doc projects 500–600 ms warm proof core based on TFLOPS scaling,
but no published L4 benchmark exists yet.

### 3. End-to-end iOS sign-in + Send

The most important test — the speed-test misses the witness-gen cost.

1. iOS app: sign out, kill app, reopen.
2. Sign in with Google.
3. Hit Send: $1.00 to `0xtest...`, sponsor flow.
4. Stopwatch from "tap Send" → receipt visible.

**Target end-to-end:** < 2.0s warm, < 4.0s cold. Compare against a recorded
Shinami baseline.

### 4. Fallback drill (manual chaos test)

Before declaring production-ready, **prove the fallback works**:

```bash
# Block the GPU box at the security group level
aws ec2 revoke-security-group-ingress --group-id sg-prover --protocol tcp --port 8080 --source-group sg-alb
# Run a real signing flow from the iOS app
# Expect: completes successfully, Vercel logs show:
#   [zk-prover] role=primary backend=gpu attempt=1 status=timeout ms=8000 ...
#   [zk-prover] role=fallback backend=shinami attempt=2 status=200 ms=2740
# Then re-open the SG:
aws ec2 authorize-security-group-ingress --group-id sg-prover --protocol tcp --port 8080 --source-group sg-alb
```

If the fallback log line is missing, **do not flip** `ZK_PROVER_PRIMARY=gpu`
— the toggle isn't actually wired up. Re-check `web/lib/zksigner.ts`.

---

## Cutover order of operations

Once a-j are green:

1. Set on Vercel (preview env first): `ZK_PROVER_GPU_URL=https://zk-prover.talise.io/v1`
2. Set `ZK_PROVER_FALLBACK=shinami` (explicit, even though it's the default)
3. Run smoke tests against preview deployment.
4. Promote env vars to production.
5. **Canary first** — set `ZK_PROVER_CANARY_PCT=5` for 24h. Keep
   `ZK_PROVER_PRIMARY=shinami`.
6. Watch Vercel logs: bucketed users hit GPU; fallback rate stays < 1%.
7. Bump to `ZK_PROVER_CANARY_PCT=25` for 48h.
8. Flip `ZK_PROVER_PRIMARY=gpu`, drop `ZK_PROVER_CANARY_PCT` to 0
   (it's redundant once primary is gpu).
9. **Keep Shinami fallback for 30 days** — don't drop the API key until
   you've seen GPU stability across a peak-traffic day.

---

## Open questions to settle before flipping production

1. **zkey hash.** The Sui Foundation rotates the proving key when the
   circuit changes. The expected SHA-256 in §c needs to be filled in from
   `https://docs.sui.io/guides/developer/cryptography/zklogin-integration`
   at deploy time. Stale runbook != stale truth.
2. **L4 vs A10G.** Comparison doc projects 500–600 ms warm on L4 (no
   published benchmark). A10G has more public ICICLE-Snark numbers. If the
   first round of smoke tests on `g6.xlarge` shows p50 > 800 ms, swap to
   `g5.xlarge` and re-benchmark — the cost delta is $140/month.
3. **Vercel region pinning.** Talise's API routes need to deploy to a
   region close to the GPU box. Default Vercel is multi-region; the
   `vercel.json` `regions` field should be set to `["iad1"]` to colocate
   with us-east-1. **[VERIFY]** current setting before measuring p50.
