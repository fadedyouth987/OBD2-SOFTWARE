"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type Me, type SessionGrant } from "@/lib/api";

export const SESSION_KEY = "rootcause.session";

export type AuthStatus = "loading" | "signed_out" | "signed_in";

interface AuthValue {
  status: AuthStatus;
  token: string | null;
  me: Me | null;
  /** /auth/me couldn't be reached; the session is kept and retried. */
  offline: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; display_name: string; workshop_name: string }) => Promise<void>;
  signOut: () => void;
  switchWorkspace: (tenantId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Expiry from the JWT payload (seconds), without trusting anything else in it. */
export function tokenExpiry(token: string): number | null {
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

function readToken(): string | null {
  try {
    const t = window.localStorage.getItem(SESSION_KEY);
    if (!t) return null;
    const exp = tokenExpiry(t);
    if (exp !== null && exp * 1000 < Date.now() + 30_000) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return t;
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(SESSION_KEY, token);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: the session lasts for this tab only */
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    writeToken(null);
    setToken(null);
    setMe(null);
    setOffline(false);
    setStatus("signed_out");
  }, []);

  const load = useCallback(
    async (t: string) => {
      if (retryRef.current) clearTimeout(retryRef.current);
      try {
        const data = await api<Me>("/api/v1/auth/me", { token: t });
        setMe(data);
        setOffline(false);
        setError(null);
        setStatus("signed_in");
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          clear();
          setError("Your session has ended. Sign in again.");
          return;
        }
        // Offline or a server hiccup: keep the session, show it, retry.
        setOffline(true);
        setStatus("signed_in");
        setError(e instanceof Error ? e.message : "Couldn't load your account.");
        retryRef.current = setTimeout(() => void load(t), 15_000);
      }
    },
    [clear],
  );

  useEffect(() => {
    const t = readToken();
    if (!t) {
      setStatus("signed_out");
      return;
    }
    setToken(t);
    void load(t);
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== SESSION_KEY) return;
      const next = readToken();
      if (!next) clear();
      else {
        setToken(next);
        void load(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [load, clear]);

  // Sign out a little before the 12 h session token expires.
  useEffect(() => {
    if (!token) return;
    const exp = tokenExpiry(token);
    if (exp === null) return;
    const ms = exp * 1000 - Date.now() - 30_000;
    const timer = setTimeout(() => {
      clear();
      setError("Your session has ended. Sign in again.");
    }, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [token, clear]);

  const adopt = useCallback(
    async (grant: SessionGrant) => {
      writeToken(grant.access_token);
      setToken(grant.access_token);
      await load(grant.access_token);
    },
    [load],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const grant = await api<SessionGrant>("/api/v1/auth/login", { body: { email, password } });
      await adopt(grant);
    },
    [adopt],
  );

  const signUp = useCallback(
    async (input: { email: string; password: string; display_name: string; workshop_name: string }) => {
      const grant = await api<SessionGrant>("/api/v1/auth/signup", { body: input });
      await adopt(grant);
    },
    [adopt],
  );

  const switchWorkspace = useCallback(
    async (tenantId: string) => {
      const grant = await api<SessionGrant>("/api/v1/auth/switch-workspace", {
        body: { tenant_id: tenantId },
        token,
      });
      await adopt(grant);
    },
    [adopt, token],
  );

  const refresh = useCallback(async () => {
    if (token) await load(token);
  }, [load, token]);

  const value = useMemo<AuthValue>(
    () => ({ status, token, me, offline, error, signIn, signUp, signOut: clear, switchWorkspace, refresh }),
    [status, token, me, offline, error, signIn, signUp, clear, switchWorkspace, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
