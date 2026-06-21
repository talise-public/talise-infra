<div align="center">

# Talise Infrastructure

**The backend that makes every Talise send gasless.**

[Live app](https://app.talise.io) · [Frontend](https://github.com/talise-public/talise-frontend) · [Contracts](https://github.com/talise-public/talise-contracts) · [Mobile](https://github.com/talise-public/talise-mobile)

</div>

---

## What this is

Operational infrastructure for Talise, a gasless US dollar account on Sui.

## gas-sponsorship

The gas station behind Talise's gasless experience. It is a Cloudflare Worker that signs as the **gas owner** for user transactions, so a user never has to hold or spend a gas token. The user signs their half with zkLogin, this service sponsors the gas and submits, and the transaction settles on Sui.

- **Policy enforced.** It only signs for Talise's own Move packages (send, vault, cheque, stream, and similar), with per-policy gas budget and command-kind limits.
- **Gasless by design.** The user pays nothing to transact. Talise covers gas at the edge.
- **Built on Onara.** This service builds on the open-source [Onara](https://github.com/unconfirmedlabs/onara) gas station pattern, adapted to Talise's policies and rails.

See [`gas-sponsorship/`](./gas-sponsorship) for the service, its policies, and the client SDK.

## Security

No secrets are committed. The signer key and runtime configuration are provided as deployment secrets, never as files. Templates end in `.example`, and the gitignore blocks real `.dev.vars`, `.env`, and key files.

## License

MIT. See [LICENSE](./LICENSE).
