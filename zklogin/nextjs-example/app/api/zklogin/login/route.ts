import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { googleAuthUrl } from "@/lib/zklogin/google";

export const runtime = "nodejs";

/**
 * GET /api/zklogin/login?nonce=… → 302 to Google.
 *
 * The browser creates the ephemeral session first (it owns the nonce), then
 * sends the user here. We stash a CSRF `state` in an httpOnly cookie and bounce
 * to Google's consent screen with the session nonce attached.
 */
export async function GET(req: NextRequest) {
  const nonce = req.nextUrl.searchParams.get("nonce");
  if (!nonce) {
    return NextResponse.json({ error: "nonce required" }, { status: 400 });
  }
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(googleAuthUrl({ nonce, state }));
  res.cookies.set("zk_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // survive the round-trip back from Google
    path: "/",
    maxAge: 600,
  });
  return res;
}
