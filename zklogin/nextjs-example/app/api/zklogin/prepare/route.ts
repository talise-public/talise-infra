import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { openSession, SESSION_COOKIE } from "@/lib/zklogin/session";

export const runtime = "nodejs";

/**
 * POST /api/zklogin/prepare { to?, amountMist? } → { txBytesB64 }.
 *
 * Builds a DEMO transaction (a SUI transfer) from the signed-in user's address
 * and returns the BCS bytes for the browser to sign with its ephemeral key.
 * Defaults to sending 0.001 SUI to yourself, so the demo works as long as the
 * address holds a little SUI for gas (testnet faucet: https://faucet.sui.io).
 *
 * Swap this for whatever your app actually does — the only contract with the
 * client is: return the exact `txBytesB64` that /execute will submit verbatim.
 */
export async function POST(req: NextRequest) {
  const jar = await cookies();
  const session = openSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    to?: string;
    amountMist?: number | string;
  };
  const recipient = (body.to ?? session.address).trim();
  const amount = BigInt(body.amountMist ?? 1_000_000); // 0.001 SUI

  const network = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
    | "testnet"
    | "mainnet"
    | "devnet";
  const client = new SuiClient({ url: getFullnodeUrl(network) });

  const tx = new Transaction();
  tx.setSender(session.address);
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin], recipient);

  const txBytes = await tx.build({ client });
  return NextResponse.json({ txBytesB64: toBase64(txBytes) });
}
