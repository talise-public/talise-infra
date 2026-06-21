import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { fromBase64 } from "@mysten/sui/utils";
import { openSession, SESSION_COOKIE } from "@/lib/zklogin/session";
import { createZkLoginProof } from "@/lib/zklogin/shinami";
import {
  extendedEphemeralPublicKey,
  addressSeed,
  assembleSignature,
} from "@/lib/zklogin/zklogin";

export const runtime = "nodejs";

/**
 * POST /api/zklogin/execute
 *   { txBytesB64, userSignature, ephemeralPubKeyB64, maxEpoch, randomness }
 *   → { digest }
 *
 * The signing finale:
 *   1. Mint a zkLogin proof from Shinami (JWT + salt from the session cookie;
 *      ephemeral pubkey + maxEpoch + randomness from the browser).
 *   2. Compute the addressSeed locally and attach it to the proof.
 *   3. Combine proof + the user's ephemeral signature → zkLoginSignature.
 *   4. Submit the tx.
 *
 * Production tip: cache the proof (step 1) per ephemeral session and skip it on
 * subsequent sends — it's the only slow part (~2-4s). Only `userSignature`
 * changes per transaction.
 */
export async function POST(req: NextRequest) {
  const jar = await cookies();
  const session = openSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { txBytesB64, userSignature, ephemeralPubKeyB64, maxEpoch, randomness } =
    (await req.json()) as {
      txBytesB64: string;
      userSignature: string;
      ephemeralPubKeyB64: string;
      maxEpoch: number;
      randomness: string;
    };
  if (!txBytesB64 || !userSignature || !ephemeralPubKeyB64 || maxEpoch == null || !randomness) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  // sub + aud come from the (already-verified-at-login) JWT payload.
  const claims = JSON.parse(
    Buffer.from(session.jwt.split(".")[1], "base64url").toString("utf8")
  ) as { sub: string; aud: string };

  try {
    const proofCore = await createZkLoginProof({
      jwt: session.jwt,
      maxEpoch,
      extendedEphemeralPublicKey: extendedEphemeralPublicKey(ephemeralPubKeyB64),
      jwtRandomness: randomness,
      salt: session.salt,
    });

    const signature = assembleSignature({
      proof: {
        ...proofCore,
        addressSeed: addressSeed({
          salt: session.salt,
          sub: claims.sub,
          aud: claims.aud,
        }),
      },
      maxEpoch,
      userSignature,
    });

    const network = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
      | "testnet"
      | "mainnet"
      | "devnet";
    const client = new SuiClient({ url: getFullnodeUrl(network) });
    const res = await client.executeTransactionBlock({
      transactionBlock: fromBase64(txBytesB64),
      signature,
      options: { showEffects: true },
    });
    return NextResponse.json({ digest: res.digest });
  } catch (e) {
    console.error("[zklogin/execute]", (e as Error).message);
    return NextResponse.json(
      { error: "execute failed", detail: (e as Error).message },
      { status: 502 }
    );
  }
}
