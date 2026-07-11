# Sponsor mnemonic rotation runbook

The Onara sponsor keypair (`SUI_MNEMONIC`) signs every gas-sponsored
transaction. Treat it as a payments-grade secret: a leak means an
attacker can consume sponsor gas inside the bounds of `policies/talise.json`.

Rotate immediately if:

- the mnemonic ever lived in `.dev.vars` on a shared / cloud-synced /
  backed-up machine,
- a developer device that touched it is lost, stolen, or wiped,
- shell history, screen recordings, screenshots, or chat logs may
  contain it,
- there is any uncertainty about who has seen it.

Production secrets only ever live in Cloudflare's encrypted secret
store. Local `.dev.vars` files must contain testnet keys only.

## Procedure

1. **Generate a fresh Sui mnemonic** on a clean machine.

   ```bash
   sui keytool generate ed25519
   ```

   Capture the mnemonic + derived address from the output. Do not
   paste it into shell history, logs, or chat. Treat the terminal
   buffer as ephemeral.

2. **Push the new mnemonic into Cloudflare** as a Wrangler secret.

   ```bash
   wrangler secret put SUI_MNEMONIC --env production
   ```

   Paste at the prompt. Wrangler never echoes or persists secrets in
   `wrangler.jsonc`. Repeat for any staging / preview environment
   that funds real money.

3. **Drain the old key.** Transfer the entire balance of the old
   sponsor address to the new sponsor address using a trusted Sui
   client. Verify the post-transfer balance of the old address is
   below the dust threshold so it can no longer sponsor anything
   meaningful.

   ```bash
   sui client transfer --to <NEW_SPONSOR_ADDRESS> --object-id <SUI_COIN> --gas-budget 10000000
   ```

   If the old address held non-SUI gas reserves (e.g. SUI in the
   balance accumulator), drain those too with `coin::send_funds` /
   `coin::take`.

4. **Update local development.** Replace the mnemonic in every
   developer's local `onara/api/.dev.vars` with a **testnet-only**
   key. The local file is git-ignored but must never contain a real
   mainnet mnemonic again.

   ```bash
   # onara/api/.dev.vars (LOCAL ONLY)
   SUI_NETWORK=testnet
   SUI_GRPC_URL=https://fullnode.testnet.sui.io:443
   SUI_MNEMONIC=<testnet-mnemonic>
   TALISE_PACKAGE_ID=<testnet-package-id>
   ```

5. **Audit for leaks of the old mnemonic.** Search:

   - shell history on every machine that touched it (`history`,
     `~/.zsh_history`, `~/.bash_history`, `~/.local/share/fish/...`),
   - editor swap / backup files (`.swp`, `~`, `Untitled-*`),
     `~/Library/Application Support/Code/User/History/`,
   - `iCloud Drive`, `Dropbox`, `Google Drive`, and any other cloud
     sync target the developer machine writes into,
   - Time Machine and other system-image backups,
   - Slack / Discord / Linear / Notion / Google Docs search,
   - CI logs and any past wrangler / deploy command output.

   If any hit is found, treat the new key as also compromised and
   restart at step 1.

6. **Re-point monitoring.** Update sponsorship analytics and
   on-call alerting to flag activity for the new sponsor address.
   Remove the old address from active dashboards. Keep a passive
   alert on the old address for at least one quarter that fires on
   any non-zero balance or signing activity. A late leak should
   page someone.

## Verification

After rotation:

- `GET /status` returns the new sponsor address.
- A test `POST /sponsor` against the policy-allowed Talise targets
  succeeds with the new sponsor address as `gasData.owner`.
- The old sponsor address shows zero balance and zero outgoing tx
  for the period since rotation.

## Why this exists

This runbook is referenced by codebase audit finding **P0-2** in
`/audits/codebase-audit.md`. If you find yourself improvising any
step above, stop and reread.
