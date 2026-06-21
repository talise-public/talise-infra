#!/usr/bin/env bash
# =============================================================================
# deploy-gpu-prover.sh
#
# One-shot provisioner for the unconfirmedlabs/sui-zklogin-gpu-prover behind
# a Caddy-managed Let's Encrypt cert. Outputs the HTTPS URL to drop into
# Vercel's ZK_PROVER_GPU_URL env var.
#
# Usage:
#   bash infra/prover/gpu/deploy.sh                          # default: runpod
#   bash infra/prover/gpu/deploy.sh --target=runpod
#   bash infra/prover/gpu/deploy.sh --target=lambda-labs
#   bash infra/prover/gpu/deploy.sh --target=aws
#   bash infra/prover/gpu/deploy.sh --target=fly
#
# Required env vars per provider:
#   runpod      RUNPOD_API_KEY
#   lambda-labs LAMBDA_LABS_API_KEY
#   aws         AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or default profile)
#   fly         FLY_API_TOKEN
#
# Common env vars (optional):
#   DOMAIN              hostname for the TLS cert. Default: zk-prover.talise.io
#   ADMIN_EMAIL         email Let's Encrypt sends expiry warnings to.
#                       Default: claudedummies@gmail.com
#   IMAGE               container image to run.
#                       Default: ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1
#   GHCR_USERNAME       GitHub username for ghcr.io pull. Default: SeventhOdyssey71
#   GHCR_TOKEN          PAT with `read:packages`. If unset and `gh` is on the
#                       local box, the script will try `gh auth token`.
#   GPU_TYPE            provider-specific GPU sku override.
#                       Defaults are L4 / A10 class, 24GB+ VRAM.
#
# Constraint: the prover serves at PORT 8080 with /healthz and /input.
# Caddy reverse-proxies 443 -> 127.0.0.1:8080 and handles ACME.
# =============================================================================

set -euo pipefail

# ---- args -------------------------------------------------------------------
TARGET="runpod"
for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#*=}" ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

DOMAIN="${DOMAIN:-zk-prover.talise.io}"
ADMIN_EMAIL="${ADMIN_EMAIL:-claudedummies@gmail.com}"
IMAGE="${IMAGE:-ghcr.io/seventhodyssey71/sui-zklogin-gpu-prover:v1}"
GHCR_USERNAME="${GHCR_USERNAME:-SeventhOdyssey71}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yel()   { printf '\033[33m%s\033[0m\n' "$*"; }

bold "==> Talise GPU prover deploy"
echo "    target       : $TARGET"
echo "    domain       : $DOMAIN"
echo "    image        : $IMAGE"
echo "    admin email  : $ADMIN_EMAIL"
echo

# ---- preflight: GHCR pull credentials --------------------------------------
if [[ -z "${GHCR_TOKEN:-}" ]]; then
  if command -v gh >/dev/null 2>&1; then
    GHCR_TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
fi
if [[ -z "${GHCR_TOKEN:-}" ]]; then
  yel "GHCR_TOKEN not set and gh is not logged in. The GPU host will pull"
  yel "from ghcr.io anonymously — make the package public (Settings → Packages"
  yel "→ change visibility) or export GHCR_TOKEN=<PAT with read:packages>."
fi

# ---- caddy + docker bootstrap script (uploaded to every provider) ----------
#
# Cloud-init / user-data: installs Docker + NVIDIA Container Toolkit + Caddy,
# fetches the zkLogin proving key (~700MB) from Mysten's ceremony repo via
# git-lfs, verifies its Blake2b hash, then docker-runs the prover behind
# Caddy. Designed to be idempotent: re-running it on the same host upgrades
# the image without re-downloading the zkey.
#
# Expected Blake2b hash for zkLogin-main.zkey:
#   060beb961802568ac9ac7f14de0fbcd55e373e8f5ec7cc32189e26fb65700aa4e36f5604f868022c765e634d14ea1cd58bd4d79cef8f3cf9693510696bcbcbce
# Sourced from scripts/fetch-zklogin-zkey.sh in unconfirmedlabs repo.

read -r -d '' BOOTSTRAP_SCRIPT <<'BOOTSTRAP_EOF' || true
#!/usr/bin/env bash
set -euo pipefail

DOMAIN="__DOMAIN__"
ADMIN_EMAIL="__ADMIN_EMAIL__"
IMAGE="__IMAGE__"
GHCR_USERNAME="__GHCR_USERNAME__"
GHCR_TOKEN="__GHCR_TOKEN__"
ZK_PROVER_AUTH_TOKEN="__ZK_PROVER_AUTH_TOKEN__"

ZKEY_URL="https://github.com/sui-foundation/zklogin-ceremony-contributions.git"
ZKEY_FILE="zkLogin-main.zkey"
ZKEY_B2_EXPECTED="060beb961802568ac9ac7f14de0fbcd55e373e8f5ec7cc32189e26fb65700aa4e36f5604f868022c765e634d14ea1cd58bd4d79cef8f3cf9693510696bcbcbce"
ZKEY_HOST_PATH=/opt/zkeys/${ZKEY_FILE}

echo "[bootstrap] system update"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg lsb-release git git-lfs jq debian-keyring debian-archive-keyring apt-transport-https

# --- Docker ---
if ! command -v docker >/dev/null 2>&1; then
  echo "[bootstrap] installing docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin
fi

# --- NVIDIA Container Toolkit ---
if ! command -v nvidia-ctk >/dev/null 2>&1; then
  echo "[bootstrap] installing nvidia container toolkit"
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq
  apt-get install -y -qq nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi

# Quick smoke: can the host see the GPU through docker?
if ! docker run --rm --gpus all nvidia/cuda:12.9.1-base-ubuntu24.04 nvidia-smi >/dev/null 2>&1; then
  echo "[bootstrap] WARNING: nvidia-smi failed inside docker. Check driver >= 555." >&2
fi

# --- Caddy (TLS + reverse proxy) ---
if ! command -v caddy >/dev/null 2>&1; then
  echo "[bootstrap] installing caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# --- zkLogin proving key ---
mkdir -p /opt/zkeys
if [[ ! -f "${ZKEY_HOST_PATH}" ]]; then
  echo "[bootstrap] fetching zkLogin-main.zkey from Mysten ceremony repo (~700MB)"
  git lfs install --system
  WORK=$(mktemp -d)
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 "${ZKEY_URL}" "${WORK}/ceremony"
  git -C "${WORK}/ceremony" lfs install --local
  git -C "${WORK}/ceremony" lfs pull --include "${ZKEY_FILE}"
  mv "${WORK}/ceremony/${ZKEY_FILE}" "${ZKEY_HOST_PATH}"
  rm -rf "${WORK}"
fi

# Verify the blake2b hash. This is the same hash the upstream repo verifies
# in scripts/fetch-zklogin-zkey.sh — if it changes, Mysten rotated the key.
if command -v b2sum >/dev/null 2>&1; then
  ACTUAL_B2=$(b2sum "${ZKEY_HOST_PATH}" | awk '{print $1}')
  if [[ "${ACTUAL_B2}" != "${ZKEY_B2_EXPECTED}" ]]; then
    echo "[bootstrap] ERROR: zkey blake2b mismatch" >&2
    echo "  expected: ${ZKEY_B2_EXPECTED}" >&2
    echo "  actual:   ${ACTUAL_B2}" >&2
    exit 1
  fi
  echo "[bootstrap] zkey blake2b verified."
else
  echo "[bootstrap] WARNING: b2sum not present; skipping zkey hash check." >&2
fi

# --- GHCR login (optional — only if the image is private) ---
if [[ -n "${GHCR_TOKEN}" && "${GHCR_TOKEN}" != "__GHCR_TOKEN__" ]]; then
  echo "[bootstrap] logging in to ghcr.io"
  echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin
fi

# --- Pull + run the prover ---
echo "[bootstrap] pulling ${IMAGE}"
docker pull "${IMAGE}"

# Recreate any prior container.
docker rm -f zklogin-prover 2>/dev/null || true

echo "[bootstrap] launching zklogin-prover container"
docker run -d \
  --name zklogin-prover \
  --restart unless-stopped \
  --gpus all \
  -p 127.0.0.1:8080:8080 \
  -v "${ZKEY_HOST_PATH}":/keys/zkLogin-main.zkey:ro \
  -e PROVER_BACKENDS=gpu,cpu \
  -e ICICLE_DEVICE=CUDA \
  -e WITNESS_WORKERS=4 \
  -e GPU_PROOF_WORKERS=1 \
  -e CPU_PROOF_WORKERS=1 \
  -e PROVER_REQUEST_TIMEOUT_MS=30000 \
  "${IMAGE}"

# --- Caddyfile (auto Let's Encrypt) ---
cat > /etc/caddy/Caddyfile <<CADDY
{
    email ${ADMIN_EMAIL}
}

${DOMAIN} {
    # P1-6: /input and /warmup require Bearer token auth so
    # arbitrary internet callers can't burn GPU cycles on us.
    # /healthz stays open for uptime checks.
    @needs_auth path /input /warmup
    @bad_auth {
        path /input /warmup
        not header Authorization "Bearer ${ZK_PROVER_AUTH_TOKEN}"
    }
    respond @bad_auth "unauthorized" 401 {
        close
    }

    reverse_proxy 127.0.0.1:8080 {
        header_up Host {host}
        transport http {
            response_header_timeout 30s
            dial_timeout            5s
        }
    }

    # Reject anything outside the actual prover API surface. Keeps random
    # internet noise off the box.
    @denied {
        not path /healthz /input /warmup
    }
    respond @denied "not found" 404

    log {
        output file /var/log/caddy/zklogin-prover.log {
            roll_size 100mb
            roll_keep 7
        }
    }
}
CADDY

systemctl reload caddy || systemctl restart caddy

echo "[bootstrap] waiting for container healthcheck"
for i in {1..60}; do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "[bootstrap] container is healthy."
    break
  fi
  sleep 3
done

echo "[bootstrap] DONE. Test from your laptop:"
echo "  curl -fsS https://${DOMAIN}/healthz"
BOOTSTRAP_EOF

# Substitute placeholders before sending to a remote host.
# ZK_PROVER_AUTH_TOKEN must be set in the deploy environment so the
# Caddy sidecar gates /input and /warmup behind Bearer auth. The
# same token must also be set on the Vercel side (`ZK_PROVER_AUTH_TOKEN`)
# so `callProver` in web/lib/zksigner.ts attaches it on outbound calls.
if [[ -z "${ZK_PROVER_AUTH_TOKEN:-}" ]]; then
  red "ZK_PROVER_AUTH_TOKEN is required. Generate one with:"
  red "  openssl rand -hex 32"
  red "then export it and set the same value on Vercel."
  exit 1
fi

render_bootstrap() {
  printf '%s' "$BOOTSTRAP_SCRIPT" \
    | sed -e "s|__DOMAIN__|${DOMAIN}|g" \
          -e "s|__ADMIN_EMAIL__|${ADMIN_EMAIL}|g" \
          -e "s|__IMAGE__|${IMAGE}|g" \
          -e "s|__GHCR_USERNAME__|${GHCR_USERNAME}|g" \
          -e "s|__GHCR_TOKEN__|${GHCR_TOKEN:-__GHCR_TOKEN__}|g" \
          -e "s|__ZK_PROVER_AUTH_TOKEN__|${ZK_PROVER_AUTH_TOKEN}|g"
}

# ---- per-provider provisioning ---------------------------------------------

deploy_runpod() {
  bold "==> Provider: RunPod"
  if [[ -z "${RUNPOD_API_KEY:-}" ]]; then
    red "RUNPOD_API_KEY not set."
    cat <<'EOM'

Get a key:
  1. Sign up: https://runpod.io/console/user/settings
  2. Top-up at least $10 of credits.
  3. Settings -> API Keys -> Create API Key (Read+Write).
  4. export RUNPOD_API_KEY=...

Recommended sku: NVIDIA L4 24GB ($0.44/hr, ~$317/mo).
EOM
    exit 1
  fi

  : "${GPU_TYPE:=NVIDIA L4}"

  bold "==> Creating pod (gpuTypeId=${GPU_TYPE})"
  # RunPod's GraphQL API. We use a template that already has docker + nvidia
  # container toolkit baked in (RunPod's "Docker"/"Ubuntu 22.04 CUDA 12.x").
  # The bootstrap script runs via SSH after the pod is up.
  BOOTSTRAP_B64=$(render_bootstrap | base64 | tr -d '\n')

  cat <<EOF
[runpod] This script will POST to https://api.runpod.io/graphql to spin up
[runpod] a Secure Cloud pod. Then it will SSH in and execute the bootstrap
[runpod] script. Total time ~5-8 minutes for provision + zkey download +
[runpod] container pull + first Let's Encrypt cert.
EOF

  # The runpodctl CLI works too; we use REST directly to keep the script
  # tool-free. The exact GraphQL mutation:
  RESPONSE=$(curl -fsS -X POST https://api.runpod.io/graphql \
    -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @- <<EOJSON
{
  "query": "mutation { podFindAndDeployOnDemand(input: { cloudType: ${CLOUD_TYPE}, gpuCount: 1, volumeInGb: 20, containerDiskInGb: 25, minVcpuCount: 4, minMemoryInGb: 16, gpuTypeId: \"${GPU_TYPE}\", name: \"talise-zklogin-prover\", imageName: \"runpod/base:0.6.2-cuda12.4.1\", dockerArgs: \"\", ports: \"22/tcp,443/tcp,80/tcp\", volumeMountPath: \"/workspace\", env: [{ key: \"BOOTSTRAP_B64\", value: \"${BOOTSTRAP_B64}\" }] }) { id imageName machineId } }"
}
EOJSON
)
  POD_ID=$(echo "$RESPONSE" | jq -r '.data.podFindAndDeployOnDemand.id // empty')
  if [[ -z "$POD_ID" ]]; then
    red "RunPod returned no pod id. Response:"
    echo "$RESPONSE" >&2
    exit 1
  fi
  green "Pod created: $POD_ID"

  bold "==> Waiting for pod to expose SSH"
  # Poll until a TCP port for SSH is published.
  for i in {1..60}; do
    POD=$(curl -fsS -X POST https://api.runpod.io/graphql \
      -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"{ pod(input:{podId:\\\"${POD_ID}\\\"}){ runtime { ports { ip publicPort privatePort } } } }\"}")
    PORT=$(echo "$POD" | jq -r '.data.pod.runtime.ports[]? | select(.privatePort==22) | .publicPort' 2>/dev/null | head -1)
    IP=$(echo "$POD" | jq -r '.data.pod.runtime.ports[]? | select(.privatePort==22) | .ip' 2>/dev/null | head -1)
    if [[ -n "$PORT" && -n "$IP" && "$PORT" != "null" ]]; then
      green "Pod SSH reachable at $IP:$PORT"
      break
    fi
    sleep 5
  done

  if [[ -z "${PORT:-}" || -z "${IP:-}" ]]; then
    red "Pod never exposed SSH. Check https://runpod.io/console/pods/${POD_ID}"
    exit 1
  fi

  bold "==> Uploading bootstrap script via ssh"
  # Use the dedicated RunPod keypair if it exists; falls back to the
  # ssh-agent / default identity files when not present so the script
  # stays portable.
  SSH_KEY_OPT=""
  if [[ -f "$HOME/.ssh/runpod-talise" ]]; then
    SSH_KEY_OPT="-i $HOME/.ssh/runpod-talise -o IdentitiesOnly=yes"
  fi
  render_bootstrap | ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=30 $SSH_KEY_OPT -p "$PORT" "root@$IP" 'cat > /root/bootstrap.sh && chmod +x /root/bootstrap.sh && bash /root/bootstrap.sh'

  green "==> DONE."
  echo
  echo "Point DNS A record:  ${DOMAIN}  ->  ${IP}"
  echo "(Caddy will fetch a Let's Encrypt cert on first HTTPS request to ${DOMAIN}.)"
  echo
  echo "Once DNS propagates:"
  echo "  bash infra/prover/gpu/smoke.sh https://${DOMAIN}"
  echo
  echo "Then on Vercel:"
  echo "  vercel env add ZK_PROVER_GPU_URL production"
  echo "  # paste: https://${DOMAIN}/input"
  echo "  vercel env add ZK_PROVER_PRIMARY production"
  echo "  # paste: gpu"
  echo "  vercel --prod"
}

deploy_lambda_labs() {
  bold "==> Provider: Lambda Labs"
  if [[ -z "${LAMBDA_LABS_API_KEY:-}" ]]; then
    red "LAMBDA_LABS_API_KEY not set."
    cat <<'EOM'

Get a key:
  1. Sign up: https://cloud.lambdalabs.com
  2. Add a payment method (no free tier for GPU).
  3. API Keys -> Generate.
  4. export LAMBDA_LABS_API_KEY=...

Recommended sku: gpu_1x_a10 ($0.50/hr, ~$360/mo).
EOM
    exit 1
  fi

  : "${GPU_TYPE:=gpu_1x_a10}"
  : "${LL_REGION:=us-east-1}"

  bold "==> Listing available instance types in ${LL_REGION}"
  AVAIL=$(curl -fsS -u "${LAMBDA_LABS_API_KEY}:" \
    "https://cloud.lambdalabs.com/api/v1/instance-types")
  if ! echo "$AVAIL" | jq -e ".data.\"${GPU_TYPE}\".regions_with_capacity_available[] | select(.name==\"${LL_REGION}\")" >/dev/null 2>&1; then
    yel "No ${GPU_TYPE} capacity in ${LL_REGION}. Try a different region:"
    echo "$AVAIL" | jq -r ".data.\"${GPU_TYPE}\".regions_with_capacity_available[].name" || true
    exit 1
  fi

  bold "==> Need an SSH key uploaded to Lambda first"
  KEY_LIST=$(curl -fsS -u "${LAMBDA_LABS_API_KEY}:" https://cloud.lambdalabs.com/api/v1/ssh-keys)
  SSH_KEY_NAME=$(echo "$KEY_LIST" | jq -r '.data[0].name // empty')
  if [[ -z "$SSH_KEY_NAME" ]]; then
    red "Upload an SSH public key first (Lambda dashboard -> SSH Keys)."
    exit 1
  fi
  echo "Using existing key: $SSH_KEY_NAME"

  bold "==> Launching instance"
  LAUNCH=$(curl -fsS -u "${LAMBDA_LABS_API_KEY}:" \
    -H 'Content-Type: application/json' \
    -d "{\"region_name\":\"${LL_REGION}\",\"instance_type_name\":\"${GPU_TYPE}\",\"ssh_key_names\":[\"${SSH_KEY_NAME}\"],\"name\":\"talise-zklogin-prover\"}" \
    https://cloud.lambdalabs.com/api/v1/instance-operations/launch)
  ID=$(echo "$LAUNCH" | jq -r '.data.instance_ids[0] // empty')
  if [[ -z "$ID" ]]; then
    red "launch failed: $LAUNCH"
    exit 1
  fi
  green "Instance launched: $ID. Waiting for IP..."
  IP=""
  for i in {1..60}; do
    INFO=$(curl -fsS -u "${LAMBDA_LABS_API_KEY}:" "https://cloud.lambdalabs.com/api/v1/instances/${ID}")
    IP=$(echo "$INFO" | jq -r '.data.ip // empty')
    STATUS=$(echo "$INFO" | jq -r '.data.status // empty')
    if [[ -n "$IP" && "$STATUS" == "active" ]]; then break; fi
    sleep 5
  done
  if [[ -z "$IP" ]]; then red "instance never became active"; exit 1; fi
  green "Instance active at $IP"

  bold "==> Running bootstrap via SSH"
  render_bootstrap | ssh -o StrictHostKeyChecking=no "ubuntu@${IP}" 'sudo bash -s'

  green "DONE."
  echo "Point DNS A record:  ${DOMAIN}  ->  ${IP}"
  echo "Then:  bash infra/prover/gpu/smoke.sh https://${DOMAIN}"
}

deploy_aws() {
  bold "==> Provider: AWS"
  if ! command -v aws >/dev/null 2>&1; then
    red "aws CLI not installed."
    exit 1
  fi
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    red "AWS creds not configured."
    cat <<'EOM'

Get creds:
  1. Sign up / sign in: https://console.aws.amazon.com/
  2. IAM -> Users -> Your user -> Security credentials -> Create access key
     (pick "Command Line Interface").
  3. Either run `aws configure` and paste them, or export:
       export AWS_ACCESS_KEY_ID=...
       export AWS_SECRET_ACCESS_KEY=...
       export AWS_DEFAULT_REGION=us-east-1
  4. You also need an EC2 key pair in your region:
       aws ec2 create-key-pair --key-name talise-zklogin --query KeyMaterial --output text > ~/.ssh/talise-zklogin.pem
       chmod 600 ~/.ssh/talise-zklogin.pem
       export AWS_KEYPAIR_NAME=talise-zklogin

Recommended sku: g6.xlarge (1x L4, 24GB) on-demand $0.8048/hr.
                 Switch to 1yr reserved (~36% saving) after 30-day burn-in.
EOM
    exit 1
  fi

  : "${AWS_REGION:=us-east-1}"
  : "${GPU_TYPE:=g6.xlarge}"
  : "${AWS_KEYPAIR_NAME:?Need AWS_KEYPAIR_NAME (existing EC2 key pair name) to ssh into the box}"

  bold "==> Looking up latest Ubuntu 22.04 AMI with GPU drivers"
  # Deep Learning Base GPU AMI (Ubuntu 22.04) - has NVIDIA driver preinstalled
  AMI=$(aws ec2 describe-images --region "$AWS_REGION" --owners amazon \
    --filters "Name=name,Values=Deep Learning Base GPU AMI (Ubuntu 22.04)*" \
              "Name=state,Values=available" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)
  if [[ -z "$AMI" || "$AMI" == "None" ]]; then
    red "could not locate Deep Learning Base AMI"; exit 1
  fi
  echo "AMI: $AMI"

  # Security group
  SG_ID=$(aws ec2 describe-security-groups --region "$AWS_REGION" \
    --filters "Name=group-name,Values=talise-zklogin-prover-sg" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
  if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
    SG_ID=$(aws ec2 create-security-group --region "$AWS_REGION" \
      --group-name talise-zklogin-prover-sg --description "talise zklogin prover" \
      --query GroupId --output text)
    aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" --protocol tcp --port 22 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0
    aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0
  fi
  echo "SG: $SG_ID"

  bold "==> Launching $GPU_TYPE in $AWS_REGION"
  USER_DATA=$(render_bootstrap | base64 -w0 2>/dev/null || render_bootstrap | base64)
  INSTANCE_ID=$(aws ec2 run-instances --region "$AWS_REGION" \
    --image-id "$AMI" --instance-type "$GPU_TYPE" \
    --key-name "$AWS_KEYPAIR_NAME" --security-group-ids "$SG_ID" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3}' \
    --user-data "$USER_DATA" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=talise-zklogin-prover}]' \
    --query 'Instances[0].InstanceId' --output text)
  green "Instance: $INSTANCE_ID. Waiting for running state..."
  aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
  IP=$(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
  green "Running at $IP"

  cat <<EOF

User-data is executing remotely (Docker, NVIDIA toolkit, Caddy, image pull).
Watch progress:
  ssh ubuntu@${IP} 'sudo tail -f /var/log/cloud-init-output.log'

Point DNS:  ${DOMAIN}  ->  ${IP}
Then:  bash infra/prover/gpu/smoke.sh https://${DOMAIN}
EOF
}

deploy_fly() {
  bold "==> Provider: Fly.io"
  red "Fly.io GPU is the most expensive (~\$2.50/hr) and lacks a managed L4 sku."
  red "We do not recommend this for steady-state hosting."
  red "Aborting. If you really want this, run with FLY_FORCE=1."
  if [[ "${FLY_FORCE:-0}" != "1" ]]; then
    exit 1
  fi
  if [[ -z "${FLY_API_TOKEN:-}" ]]; then
    red "FLY_API_TOKEN not set. Get one with: flyctl auth token"
    exit 1
  fi
  red "Fly path is not implemented — install flyctl and run:"
  echo "  flyctl apps create talise-zklogin-prover"
  echo "  flyctl scale vm a100-40gb --app talise-zklogin-prover"
  echo "  flyctl deploy --app talise-zklogin-prover --image ${IMAGE}"
  exit 1
}

case "$TARGET" in
  runpod)       deploy_runpod ;;
  lambda-labs)  deploy_lambda_labs ;;
  aws)          deploy_aws ;;
  fly)          deploy_fly ;;
  *) red "Unknown --target=$TARGET (allowed: runpod, lambda-labs, aws, fly)"; exit 2 ;;
esac
