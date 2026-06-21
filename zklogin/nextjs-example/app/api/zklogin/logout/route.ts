import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/zklogin/session";

export const runtime = "nodejs";

/** POST /api/zklogin/logout → clear the session cookie. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
