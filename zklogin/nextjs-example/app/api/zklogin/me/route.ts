import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { openSession, SESSION_COOKIE } from "@/lib/zklogin/session";

export const runtime = "nodejs";

/** GET /api/zklogin/me → who's signed in (address + profile). Never returns the
 *  JWT or salt. */
export async function GET() {
  const jar = await cookies();
  const s = openSession(jar.get(SESSION_COOKIE)?.value);
  if (!s) return NextResponse.json({ signedIn: false });
  return NextResponse.json({
    signedIn: true,
    address: s.address,
    email: s.email ?? null,
    name: s.name ?? null,
  });
}
