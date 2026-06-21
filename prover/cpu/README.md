# Talise zkLogin prover

Self-hosted Sui zkLogin proof generator. Mysten's public mainnet prover
whitelists OAuth audiences (ours isn't on it); running our own removes the
gatekeeper.

## One-time setup

```bash
# 1. Pull the mainnet proving key (~3.2 GB).
bash infra/prover/cpu/download-zkey.sh

# 2. Boot the prover stack.
docker compose -f infra/prover/cpu/docker-compose.yml up -d

# 3. Wait ~30 s for the prover to load the key into memory, then ping.
curl http://localhost:8001/ping
# → OK
```

## Wiring the web app to it

In `web/.env.local`:

```bash
NEXT_PUBLIC_SUI_NETWORK=mainnet
ZK_PROVER_URL=http://localhost:8001/v1
```

The `web` app reads `ZK_PROVER_URL` in `lib/zksigner.ts`. If unset, it falls
back to Mysten's public hosted prover.

## Hardware

- Memory: ~6 GB resident once the zkey is loaded. Set Docker Desktop's RAM
  limit to at least 8 GB.
- CPU: cold proof takes 8–15 s on an M1/M2. After warm-up, ~2–5 s per proof.
- Disk: 4 GB free for the zkey + Docker images.

## Production deploy

Put the same compose file on any small VPS (DigitalOcean 8 GB droplet,
Hetzner CX31, etc.), open port 8001 behind your reverse proxy with TLS, and
point `ZK_PROVER_URL` at it. The prover is stateless and horizontally
scalable — front it with a load balancer if traffic warrants.

## Health check

```bash
curl http://localhost:8001/ping
docker compose -f infra/prover/cpu/docker-compose.yml logs -f prover-fe
```

If proofs are slow on first hit, the zkey is still mmapping; subsequent
calls land in cache.
