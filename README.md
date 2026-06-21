<div align="center">

# Talise Infrastructure

**The backend that makes every Talise send gasless.**

[Website](https://talise.io) · [iOS app (TestFlight)](https://testflight.apple.com/join/BFNEPYtM) · [Frontend](https://github.com/talise-public/talise-frontend) · [Contracts](https://github.com/talise-public/talise-contracts) · [Docs](https://github.com/talise-public/talise-docs)

</div>

---

## What this is

Operational infrastructure for Talise, a gasless US dollar account on Sui. The core piece is the gas-sponsorship service that lets users transact without ever holding a gas token.

## gas-sponsorship

A Cloudflare Worker that signs as the **gas owner** for user transactions, built on the open-source [Onara](https://github.com/unconfirmedlabs/onara) gas station and adapted to Talise's policies and rails.

### How it works

1. The user builds a transaction and signs their half with zkLogin (no gas token needed).
2. The app posts the signed transaction bytes to this service.
3. The service validates the transaction against Talise's sponsor policy, signs as the gas owner, and submits it to Sui.
4. The transaction settles, and the user paid nothing in gas.

### Policy

The sponsor only signs for Talise's own Move packages (for example `send`, `vault`, `cheque`, `stream`). Each policy sets a maximum gas budget and the allowed command kinds, so the sponsor cannot be used to fund arbitrary transactions. There is also a self-fund path that keeps the sponsor's own gas topped up.

### Layout

```
gas-sponsorship/
  api/    The Cloudflare Worker: routes, policy engine, execution, analytics
  sdk/    A small TypeScript client for calling the sponsor from the app and API
```

### Run locally

```bash
cd gas-sponsorship/api
cp .dev.vars.example .dev.vars   # fill in your own values
npm install
npx wrangler dev
```

The signer key (`SUI_MNEMONIC`) and runtime config are provided as Cloudflare secrets and a local `.dev.vars`, never committed. Templates end in `.example`.

## Security

No secrets are committed. The signer key lives in Cloudflare's encrypted secret store, not in any file. The gitignore blocks real `.dev.vars`, `.env`, and key files.

## License

MIT. See [LICENSE](./LICENSE).
