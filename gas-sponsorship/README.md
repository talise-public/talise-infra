# Onara

> **Talise note:** This is Talise's production gas station. Its client lives in
> the web app at `web/lib/onara/` (client `web/lib/onara/client.ts`, public
> entry `web/lib/onara/index.ts`), imported as `@/lib/onara` and pointed at the
> `ONARA_URL` env var. It is based on the open "onara" project.

Sui transaction sponsorship: a policy-based gas station server and TypeScript client SDK.

| Package | Description |
|---|---|
| [api/](./api) | Sponsorship server (Hono on Cloudflare Workers) |
| [sdk/](./sdk) | Client SDK (`onara` on npm) |

## Quick start

```bash
bun install            # installs both workspaces
cd api && bun test     # run API policy tests
cd sdk && bun test     # run SDK tests
```
