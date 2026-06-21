import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForIdToken, verifyGoogleIdToken } from "@/lib/zklogin/google";
import { getZkLoginWallet } from "@/lib/zklogin/shinami";
import { sealSession, SESSION_COOKIE } from "@/lib/zklogin/session";

export const runtime = "nodejs";

/**
 * GET /api/zklogin/callback?code=…&state=… — Google's redirect lands here.
 *
 *   1. Verify the CSRF `state` against the cookie we set in /login.
 *   2. Exchange the code for Google's id_token (a JWT) and VERIFY its signature.
 *   3. Ask Shinami for this user's Sui address + salt (deterministic per sub).
 *   4. Seal { jwt, salt, address } into an httpOnly session cookie.
 *
 * The browser keeps holding the ephemeral key in sessionStorage — we never see
 * it. Address + salt + jwt live only server-side from here on.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = req.cookies.get("zk_oauth_state")?.value;

  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(new URL("/?error=oauth_state", url.origin));
  }

  try {
    const idToken = await exchangeCodeForIdToken(code);
    const claims = await verifyGoogleIdToken(idToken); // throws on bad sig/aud/exp
    const { address, salt } = await getZkLoginWallet(idToken);

    const res = NextResponse.redirect(new URL("/", url.origin));
    res.cookies.set(
      SESSION_COOKIE,
      sealSession({ jwt: idToken, salt, address, email: claims.email, name: claims.name }),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24, // 1 day; re-auth after that
      }
    );
    res.cookies.delete("zk_oauth_state");
    return res;
  } catch (e) {
    console.error("[zklogin/callback]", (e as Error).message);
    return NextResponse.redirect(new URL("/?error=oauth_exchange", url.origin));
  }
}
