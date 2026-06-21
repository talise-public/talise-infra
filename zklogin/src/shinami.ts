/**
 * Shinami zkLogin wrappers — salt/address + proof generation (SERVER ONLY).
 *
 * Why Shinami: Mysten's hosted mainnet prover whitelists OAuth audiences, and
 * yours probably isn't on it. Shinami runs an open zkLogin Wallet service +
 * zkProver service — register, paste the key, mainnet works. (On testnet you
 * can use Mysten's dev prover instead and skip this file.)
 *
 * Two calls:
 *   • shinami_zkw_getOrCreateZkLoginWallet(jwt) → { address, salt }
 *       Shinami derives + stores the salt deterministically per (iss, sub), so
 *       the same Google account always maps to the same Sui address. You don't
 *       have to manage salts yourself.
 *   • shinami_zkp_createZkLoginProof(jwt, maxEpoch, extEphPubKey, randomness,
 *       salt, keyClaim) → { zkProof }
 *
 * Get a key at https://app.shinami.com (zkLogin Wallet + zkProver services).
 * Docs: https://docs.shinami.com/api-docs/sui/wallet-services/zklogin-wallet-api
 */

import type { ZkProof } from "./zklogin";

const WALLET_URL = "https://api.us1.shinami.com/sui/zkwallet/v1";
const PROVER_URL = "https://api.us1.shinami.com/sui/zkprover/v1";

function apiKey(): string {
  const k = process.env.SHINAMI_API_KEY;
  if (!k) {
    throw new Error(
      "SHINAMI_API_KEY missing. Get one at https://app.shinami.com and set it in .env"
    );
  }
  return k;
}

type RpcResp<T> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string } };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) {
    throw new Error(`shinami ${method} ${r.status}: ${(await r.text()).slice(0, 240)}`);
  }
  const j = (await r.json()) as RpcResp<T>;
  if ("error" in j) throw new Error(`shinami ${method}: ${j.error.message} (${j.error.code})`);
  return j.result;
}

/** Shinami returns salt base64-encoded over JSON-RPC; genAddressSeed wants a decimal string. */
function decodeSalt(salt: string): string {
  if (/^\d+$/.test(salt)) return salt; // already decimal
  return BigInt("0x" + Buffer.from(salt, "base64").toString("hex")).toString();
}

type ShinamiWallet = { salt: string; address: string };

/** Resolve this user's Sui address + Shinami-managed salt from their Google JWT. */
export async function getZkLoginWallet(
  jwt: string
): Promise<{ address: string; salt: string }> {
  const w = await rpc<ShinamiWallet>(WALLET_URL, "shinami_zkw_getOrCreateZkLoginWallet", [jwt]);
  return { address: w.address, salt: decodeSalt(w.salt) };
}

/**
 * Mint a zkLogin proof. The expensive call (Groth16, ~2-4s) — cache the result
 * for the ephemeral session and reuse it across sends. Rate limit: ~2 proofs
 * per address per minute (error -32012 if exceeded), which the session cache
 * makes a non-issue.
 *
 * `addressSeed` is NOT returned by Shinami — compute it locally with
 * `addressSeed()` from ./zklogin and attach it to the proof before assembling.
 */
export async function createZkLoginProof(opts: {
  jwt: string;
  maxEpoch: number;
  extendedEphemeralPublicKey: string; // decimal string
  jwtRandomness: string; // decimal string
  salt: string; // decimal string
  keyClaimName?: string; // "sub"
}): Promise<Omit<ZkProof, "addressSeed">> {
  const { zkProof } = await rpc<{ zkProof: Omit<ZkProof, "addressSeed"> }>(
    PROVER_URL,
    "shinami_zkp_createZkLoginProof",
    [
      opts.jwt,
      String(opts.maxEpoch),
      opts.extendedEphemeralPublicKey,
      opts.jwtRandomness,
      opts.salt,
      opts.keyClaimName ?? "sub",
    ]
  );
  return zkProof;
}
