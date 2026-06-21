/**
 * zkLogin core — ephemeral keys, nonce, address derivation, signature assembly.
 *
 * These helpers are framework-agnostic. The split that matters:
 *
 *   • EPHEMERAL keypair + nonce  → generated in the BROWSER. The ephemeral
 *     private key signs transactions and must never leave the device. Keep it
 *     in memory / sessionStorage for the session (it expires at `maxEpoch`).
 *   • address seed + signature   → assembled on the SERVER, where the JWT,
 *     salt, and the Shinami proof live. The server never sees the ephemeral
 *     private key — only the ephemeral PUBLIC key and the user's signature.
 *
 * The pieces marked `// browser` use only Web-Crypto-safe APIs; the rest are
 * server-side. @mysten/sui's zklogin helpers run in both environments.
 */

import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  genAddressSeed,
  getZkLoginSignature,
  jwtToAddress,
} from "@mysten/sui/zklogin";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";

// ─────────────────────────────────────────────────────────────────────────
// 1. Ephemeral session (BROWSER)
// ─────────────────────────────────────────────────────────────────────────

/** Everything the browser needs to hold for one zkLogin session. */
export interface EphemeralSession {
  /** The ephemeral Ed25519 secret key as a `suiprivkey1…` bech32 string.
   *  Browser-only — this signs transactions and must never reach the server. */
  secretKey: string;
  /** Base64 of the ephemeral Ed25519 public key. Safe to send to the server. */
  publicKeyB64: string;
  /** Decimal-string randomness mixed into the nonce. */
  randomness: string;
  /** The last Sui epoch this session's proof is valid for. */
  maxEpoch: number;
  /** The OAuth `nonce` — Google echoes this into the id_token. */
  nonce: string;
}

/**
 * Create a fresh ephemeral session. Call this in the browser right before you
 * redirect the user to Google. `currentEpoch` comes from the chain
 * (`SuiClient.getLatestSuiSystemState().epoch`); `epochsValid` is how many
 * epochs the session should live (2 is the common default — ~48h on mainnet).
 *
 * `browser`
 */
export function createEphemeralSession(
  currentEpoch: number,
  epochsValid = 2
): EphemeralSession {
  const keypair = new Ed25519Keypair();
  const randomness = generateRandomness();
  const maxEpoch = currentEpoch + epochsValid;
  const publicKey = keypair.getPublicKey();
  const nonce = generateNonce(publicKey, maxEpoch, randomness);

  return {
    secretKey: keypair.getSecretKey(), // bech32 `suiprivkey1…`
    publicKeyB64: publicKey.toBase64(),
    randomness,
    maxEpoch,
    nonce,
  };
}

/** Re-hydrate the ephemeral keypair from a stored session (browser). */
export function ephemeralKeypair(session: EphemeralSession): Ed25519Keypair {
  // fromSecretKey accepts the bech32 `suiprivkey1…` string directly.
  return Ed25519Keypair.fromSecretKey(session.secretKey);
}

/**
 * Sign transaction bytes with the ephemeral key (browser). Returns the
 * serialized user signature that the server passes to `assembleSignature`.
 *
 * `txBytes` is the BCS-serialized `TransactionData` (what `tx.build()`
 * produces). The same bytes must be executed verbatim — don't rebuild.
 *
 * `browser`
 */
export async function signTxBytes(
  session: EphemeralSession,
  txBytes: Uint8Array
): Promise<string> {
  const { signature } = await ephemeralKeypair(session).signTransaction(txBytes);
  return signature;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Address derivation (SERVER or browser)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Derive the Sui address from a JWT + salt. With Shinami you usually get the
 * address straight from `getZkLoginWallet`, but this lets you verify it or
 * derive it yourself if you manage salts.
 */
export function deriveAddress(jwt: string, salt: string): string {
  // legacyAddress=false → the post-2024 derivation (the current default).
  return jwtToAddress(jwt, salt, false);
}

/**
 * The address seed binds (salt, keyClaim, sub, aud) and is a required input to
 * the zkLogin signature. Compute it server-side from the JWT claims + salt.
 */
export function addressSeed(opts: {
  salt: string;
  sub: string;
  aud: string;
  keyClaimName?: string; // "sub" by default
}): string {
  return genAddressSeed(
    BigInt(opts.salt),
    opts.keyClaimName ?? "sub",
    opts.sub,
    opts.aud
  ).toString();
}

/**
 * The "extended ephemeral public key" the prover wants — a decimal string.
 * Derive it from the base64 ephemeral public key the browser sent up.
 */
export function extendedEphemeralPublicKey(publicKeyB64: string): string {
  const pub = new Ed25519PublicKey(fromBase64(publicKeyB64));
  return getExtendedEphemeralPublicKey(pub);
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Signature assembly (SERVER)
// ─────────────────────────────────────────────────────────────────────────

/** The cacheable proof artifact — valid for the whole ephemeral session. */
export interface ZkProof {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  addressSeed: string;
}

/**
 * Combine the Shinami proof + the user's ephemeral signature into the final
 * `zkLoginSignature` you submit with the transaction.
 *
 * The proof is the expensive part (Groth16, ~2-4s). Cache it for the session
 * and reuse it across many sends — only the cheap `userSignature` changes.
 */
export function assembleSignature(opts: {
  proof: ZkProof;
  maxEpoch: number;
  /** The serialized ephemeral signature from `signTxBytes`. */
  userSignature: string;
}): string {
  return getZkLoginSignature({
    inputs: opts.proof,
    maxEpoch: opts.maxEpoch,
    userSignature: opts.userSignature,
  });
}

