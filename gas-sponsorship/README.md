# gas-sponsorship

**Talise's gasless-transaction sponsor.**

A Cloudflare Worker that signs as the gas owner for Talise transactions, so users never hold or spend a gas token. It is the service behind the "no gas to send" experience in the app.

## How it works

1. The user builds a transaction and signs their half with zkLogin (no gas token needed).
2. The app posts the signed transaction bytes to this service.
3. The service validates the transaction against Talise's sponsor policy, signs as the gas owner, and submits it to Sui.
4. The transaction settles, and the user paid nothing in gas.

## Policy

The sponsor only signs for Talise's own Move packages (for example `send`, `vault`, `cheque`, `stream`). Each policy sets a maximum gas budget and the allowed command kinds, so the sponsor cannot be used to fund arbitrary transactions.

## Layout

```
api/    The Cloudflare Worker: routes, policy engine, execution
sdk/    A small client SDK for calling the sponsor from the app and API
```

## Run locally

```bash
cd api
cp .dev.vars.example .dev.vars   # then fill in your own values
npm install
npx wrangler dev
```

Configuration and the signer key are provided as Worker secrets and a local `.dev.vars`, never committed. Templates end in `.example`.

## Credit

Built on the open-source [Onara](https://github.com/unconfirmedlabs/onara) gas station, adapted to Talise's policies and rails.

## License

MIT. See the repository [LICENSE](../LICENSE).
