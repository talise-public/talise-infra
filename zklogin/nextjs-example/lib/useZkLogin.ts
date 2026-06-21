"use client";

/**
 * Client hook — owns the BROWSER half of zkLogin: the ephemeral key, kicking
 * off sign-in, and the prepare → sign → execute round-trip for a transaction.
 *
 * The ephemeral key lives in sessionStorage (cleared when the tab closes).
 * That's the secret that signs transactions; it never goes to the server. The
 * server holds the JWT/salt/address in an httpOnly cookie.
 */

import { useCallback, useEffect, useState } from "react";
import { fromBase64 } from "@mysten/sui/utils";
import {
  createEphemeralSession,
  signTxBytes,
  type EphemeralSession,
} from "@/lib/zklogin/zklogin";

const EPH_KEY = "zk.ephemeral";

function loadEphemeral(): EphemeralSession | null {
  try {
    return JSON.parse(sessionStorage.getItem(EPH_KEY) ?? "null");
  } catch {
    return null;
  }
}
function saveEphemeral(s: EphemeralSession) {
  sessionStorage.setItem(EPH_KEY, JSON.stringify(s));
}

export interface ZkUser {
  address: string;
  email: string | null;
  name: string | null;
}

export function useZkLogin() {
  const [user, setUser] = useState<ZkUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/zklogin/me").then((r) => r.json());
    setUser(r.signedIn ? { address: r.address, email: r.email, name: r.name } : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Create the ephemeral session, then bounce to Google. */
  const signIn = useCallback(async () => {
    const { epoch } = await fetch("/api/zklogin/epoch").then((r) => r.json());
    const eph = createEphemeralSession(Number(epoch));
    saveEphemeral(eph);
    window.location.href = `/api/zklogin/login?nonce=${encodeURIComponent(eph.nonce)}`;
  }, []);

  const signOut = useCallback(async () => {
    sessionStorage.removeItem(EPH_KEY);
    await fetch("/api/zklogin/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }, []);

  /**
   * Send a transaction end-to-end: ask the server to build the tx → sign the
   * bytes locally with the ephemeral key → hand the signature back for proof
   * assembly + execution. Returns the on-chain digest.
   */
  const send = useCallback(
    async (opts?: { to?: string; amountMist?: number }): Promise<string> => {
      const eph = loadEphemeral();
      if (!eph) throw new Error("No ephemeral session — sign in again.");

      const { txBytesB64 } = await fetch("/api/zklogin/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }).then((r) => r.json());

      const userSignature = await signTxBytes(eph, fromBase64(txBytesB64));

      const res = await fetch("/api/zklogin/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txBytesB64,
          userSignature,
          ephemeralPubKeyB64: eph.publicKeyB64,
          maxEpoch: eph.maxEpoch,
          randomness: eph.randomness,
        }),
      }).then((r) => r.json());

      if (!res.digest) throw new Error(res.detail ?? res.error ?? "execute failed");
      return res.digest as string;
    },
    []
  );

  return { user, loading, signIn, signOut, send, refresh };
}
