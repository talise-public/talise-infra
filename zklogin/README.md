# zkLogin + Shinami — plug-and-play web example

Sign a user in **with Google**, derive a **Sui address** for them (no wallet, no
seed phrase), and **sign + submit transactions** on their behalf using a
**Shinami**-generated zkLogin proof.

This is a distilled, working extraction of the rail Talise runs in production.
Copy the four files in [`src/`](./src) into your app, wire the API routes, drop
in the hook — done.

```
infra/zklogin/
├── src/                      ← the reusable core (copy this into your app)
│   ├── zklogin.ts            ephemeral keys, nonce, addressSeed, signature assembly
│   ├── shinami.ts            Shinami: getZkLoginWallet + createZkLoginProof  (server)
│   ├── google.ts             Google OAuth: auth URL, code→id_token, verify   (server)
│   └── session.ts            AES-GCM httpOnly session cookie (jwt+salt+addr)  (server)
└── nextjs-example/           ← a runnable Next.js App Router wiring of src/
    ├── app/api/zklogin/{epoch,login,callback,me,logout,prepare,execute}/route.ts
    ├── lib/useZkLogin.ts     client hook (owns the ephemeral key + send flow)
    └── app/page.tsx          demo UI
```

## The flow (why each piece exists)

```
BROWSER                                  SERVER                         SHINAMI / GOOGLE / SUI
───────                                  ──────                         ──────────────────────
1. createEphemeralSession(epoch)
   → ephemeral keypair + randomness
   → nonce = H(ephPub, maxEpoch, rand)
2. redirect ─ /login?nonce ────────────► build Google URL ───────────► Google consent
                                                                         (echoes nonce into id_token)
3.            ◄──────── /callback?code ── exchange code → id_token
                                          verify id_token signature ──► Google JWKS
                                          getZkLoginWallet(jwt) ───────► Shinami → { address, salt }
                                          seal {jwt,salt,address} cookie
4. build tx ─ /prepare ────────────────► SuiClient builds tx → txBytes
5. sign txBytes with ephemeral key
6. ─ /execute {txBytes,userSig,ephPub,──► createZkLoginProof(...) ─────► Shinami prover (Groth16)
     maxEpoch,randomness}                 addressSeed = genAddressSeed(...)
                                          sig = getZkLoginSignature(proof,userSig)
                                          executeTransactionBlock ─────► Sui → digest
```

**The one rule that makes zkLogin safe:** the **ephemeral private key never
leaves the browser**. It signs transactions; the server only ever sees the
ephemeral *public* key + the resulting signature. The nonce baked into the
Google id_token cryptographically binds the proof to *this* ephemeral key for
*this* `maxEpoch`, so a stolen proof is useless without the matching key, and a
stolen key expires at `maxEpoch`.

**Why Shinami:** Mysten's hosted *mainnet* prover whitelists OAuth audiences;
yours likely isn't on it. Shinami runs an open zkLogin Wallet + zkProver — and
it manages the salt deterministically per Google account, so you don't have to
build salt storage. (On testnet you can point at Mysten's dev prover instead and
drop `shinami.ts`.)

## Setup

1. **Install deps** (or add them to your app):
   ```bash
   npm i @mysten/sui jose
   ```
2. **Copy the core** into your app so the example imports resolve:
   ```bash
   cp -r infra/zklogin/src  your-app/src/lib/zklogin
   # the example routes import from "@/lib/zklogin/*"
   ```
   (Ensure your `tsconfig.json` maps `"@/*": ["./src/*"]` — Next.js does by default.)
3. **Copy the routes + hook + page** from `nextjs-example/` into your app
   (or just the routes + `useZkLogin.ts` and call the hook from your own UI).
4. **Env** — copy `.env.example` to `.env.local` and fill in:
   - a Google **Web** OAuth client (`GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`)
   - a **Shinami** API key (`SHINAMI_API_KEY`, zkLogin Wallet + zkProver enabled)
   - a random `SESSION_SECRET`
   - `NEXT_PUBLIC_SUI_NETWORK=testnet`
5. In Google Cloud, add `http://localhost:3000/api/zklogin/callback` as an
   authorized redirect URI (must equal `GOOGLE_REDIRECT_URI`).
6. `npm run dev`, open the page, **Sign in with Google**, fund the shown address
   at [faucet.sui.io](https://faucet.sui.io), then **Send 0.001 SUI to myself**.

## Wiring it into your own app

You almost certainly only need three things:

- **`useZkLogin()`** — `signIn()`, `signOut()`, `user`, and `send()`.
- **Replace `/api/zklogin/prepare`** — instead of the demo self-transfer, build
  *your* transaction (a Move call, a coin transfer, a PTB) for `session.address`
  and return its `txBytesB64`. Everything else stays the same.
- **`/api/zklogin/execute`** is generic — it signs and submits whatever bytes it
  was handed. No changes needed.

To sign your own transaction from anywhere in the client:
```ts
const { send } = useZkLogin();
const digest = await send({ to: "0x…", amountMist: 5_000_000 });
```

## Performance: cache the proof

`createZkLoginProof` (Groth16) is the only slow call (~2–4s) and is rate-limited
(~2/min/address). It's valid for the **entire ephemeral session** (until
`maxEpoch`). Mint it once, cache it (server-side, keyed by the ephemeral pubkey),
and reuse it across many `/execute` calls — only `userSignature` changes per tx.
The example mints fresh each time for clarity; add a cache and sends drop to
sub-second.

## Going further

- **Gasless / sponsored** — pair this with a gas station (Shinami Gas Station, or
  a self-hosted sponsor) so the user never needs SUI. Build a *sponsored*
  `TransactionData` (sponsor = gas owner), have the user sign it with the
  ephemeral key, then attach the sponsor signature server-side before executing.
- **Apple / other OIDC** — swap `google.ts` for the provider; the rest is
  identical as long as you get a signed `id_token` carrying the `nonce`.
- **Production sessions** — `session.ts` is a minimal AES-GCM cookie; for larger
  payloads or revocation use `iron-session` or a server-side store keyed by an
  opaque id. Keep the cookie `httpOnly` + `Secure`; never expose the JWT or salt
  to the client.

## Files reference

| File | Runs on | Does |
|---|---|---|
| `src/zklogin.ts` | browser + server | ephemeral session, nonce, sign bytes, addressSeed, assemble signature |
| `src/shinami.ts` | server | `getZkLoginWallet(jwt)`, `createZkLoginProof(...)` |
| `src/google.ts` | server | auth URL, code→id_token, JWKS verify |
| `src/session.ts` | server | seal/open the httpOnly session cookie |
| `nextjs-example/.../login` | server | ephemeral nonce → redirect to Google (+CSRF state) |
| `nextjs-example/.../callback` | server | code→jwt→verify→Shinami wallet→session cookie |
| `nextjs-example/.../prepare` | server | build the tx → return bytes to sign (**replace with yours**) |
| `nextjs-example/.../execute` | server | prove → assemble → submit → digest |
| `nextjs-example/lib/useZkLogin.ts` | browser | the hook: ephemeral key + signIn + send |

Adapted from the production zkLogin rail in [Talise](https://talise.io).
Reference: <https://docs.sui.io/concepts/cryptography/zklogin> ·
<https://docs.shinami.com/api-docs/sui/wallet-services/zklogin-wallet-api>
