#!/usr/bin/env bash
# Downloads the Sui mainnet zkLogin proving key (~3.2 GB) via Git LFS, the
# canonical source (sui-foundation/zklogin-ceremony-contributions).
# Run from repo root: bash infra/prover/cpu/download-zkey.sh
# Idempotent — skips if the file already exists and the size looks right.

set -euo pipefail

PROVER_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY_DIR="$PROVER_DIR/key"
DEST="$KEY_DIR/zkLogin-main.zkey"

mkdir -p "$KEY_DIR"

if [[ -f "$DEST" ]]; then
  size=$(wc -c <"$DEST" | tr -d ' ')
  if [[ "$size" -gt 3000000000 ]]; then
    echo "✓ zkey already present at $DEST ($((size / 1024 / 1024)) MB)"
    exit 0
  fi
  echo "Found partial zkey ($size bytes) — re-downloading."
  rm -f "$DEST"
fi

if ! command -v git-lfs >/dev/null 2>&1; then
  echo "git-lfs is required. Install with: brew install git-lfs"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Cloning ceremony repo (LFS deferred) into $WORK"
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 \
  https://github.com/sui-foundation/zklogin-ceremony-contributions.git "$WORK/repo"

cd "$WORK/repo"
echo "Pulling zkLogin-main.zkey via Git LFS (this is the long part — ~3.2 GB)..."
git lfs pull --include "zkLogin-main.zkey"

mv "$WORK/repo/zkLogin-main.zkey" "$DEST"
size=$(wc -c <"$DEST" | tr -d ' ')
echo
echo "✓ Saved $DEST ($((size / 1024 / 1024)) MB)"
echo
echo "Next:  docker compose -f infra/prover/cpu/docker-compose.yml up -d"
echo "Then:  curl http://localhost:8001/ping"
