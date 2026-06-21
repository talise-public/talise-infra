import { NextResponse } from "next/server";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";

export const runtime = "nodejs";

/** GET /api/zklogin/epoch → { epoch }. The browser needs the current epoch to
 *  pick `maxEpoch` when it creates the ephemeral session. */
export async function GET() {
  const network = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
    | "testnet"
    | "mainnet"
    | "devnet";
  const client = new SuiClient({ url: getFullnodeUrl(network) });
  const { epoch } = await client.getLatestSuiSystemState();
  return NextResponse.json({ epoch: Number(epoch) });
}
