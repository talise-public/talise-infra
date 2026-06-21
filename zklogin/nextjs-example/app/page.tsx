"use client";

/**
 * Demo page — sign in with Google (zkLogin), then send a test transaction
 * signed with the ephemeral key + a Shinami proof. Intentionally unstyled so
 * the moving parts are obvious; lift the `useZkLogin` hook into your own UI.
 */

import { useState } from "react";
import { useZkLogin } from "@/lib/useZkLogin";

export default function Home() {
  const { user, loading, signIn, signOut, send } = useZkLogin();
  const [busy, setBusy] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    setBusy(true);
    setError(null);
    setDigest(null);
    try {
      setDigest(await send()); // 0.001 SUI to self by default
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main style={S.main}>Loading…</main>;

  return (
    <main style={S.main}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>zkLogin + Shinami demo</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Sign in with Google → get a Sui address → sign a transaction. No wallet,
        no seed phrase.
      </p>

      {!user ? (
        <button style={S.primary} onClick={signIn}>
          Sign in with Google
        </button>
      ) : (
        <div style={S.card}>
          <div style={{ fontSize: 13, color: "#666" }}>Signed in as</div>
          <div style={{ fontWeight: 600 }}>{user.email ?? user.name ?? "—"}</div>
          <div style={S.mono}>{user.address}</div>

          <button style={S.primary} onClick={handleSend} disabled={busy}>
            {busy ? "Signing & sending…" : "Send 0.001 SUI to myself"}
          </button>
          <button style={S.ghost} onClick={signOut}>
            Sign out
          </button>

          {digest && (
            <p style={{ color: "#137333", fontSize: 13 }}>
              ✓ Sent — digest <span style={S.mono}>{digest}</span>
            </p>
          )}
          {error && <p style={{ color: "#c5221f", fontSize: 13 }}>{error}</p>}
          <p style={{ color: "#999", fontSize: 12 }}>
            Fund this address with testnet SUI first:{" "}
            <a href="https://faucet.sui.io" target="_blank" rel="noreferrer">
              faucet.sui.io
            </a>
          </p>
        </div>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 520, margin: "60px auto", padding: 20, fontFamily: "system-ui, sans-serif" },
  card: { display: "flex", flexDirection: "column", gap: 10, padding: 18, border: "1px solid #eee", borderRadius: 14, marginTop: 16 },
  primary: { height: 44, borderRadius: 10, border: "none", background: "#111", color: "#fff", fontWeight: 600, cursor: "pointer" },
  ghost: { height: 38, borderRadius: 10, border: "1px solid #ddd", background: "#fff", color: "#333", cursor: "pointer" },
  mono: { fontFamily: "ui-monospace, monospace", fontSize: 12, wordBreak: "break-all" },
};
