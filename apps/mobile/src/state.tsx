// App-wide state: the API client, the signed-in workspace, and the dongle link.
// Sign-in happens in the web app (the same page, password or single sign-on); the
// dongle screens use that session, read from the web view when they open.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Api, ApiError, type Me } from "./api/client";
import { clearToken, loadToken, saveToken } from "./api/session";
import { API_URL } from "./config";
import { Elm327, type ElmInfo } from "./obd/elm327";
import type { Transport } from "./obd/transport";

interface AppState {
  api: Api;
  ready: boolean;
  me: Me | null;
  /** Uses the web app's session (null when the web app is signed out). */
  adoptToken(token: string | null): Promise<void>;
  signOut(): Promise<void>;
  refreshMe(): Promise<void>;
  elm: Elm327 | null;
  link: { label: string; info: ElmInfo } | null;
  linkLost: string | null;
  attach(transport: Transport): Promise<void>;
  detach(): Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => new Api(API_URL), []);
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [elm, setElm] = useState<Elm327 | null>(null);
  const [link, setLink] = useState<AppState["link"]>(null);
  const [linkLost, setLinkLost] = useState<string | null>(null);
  const dropUnsub = useRef<(() => void) | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        api.setToken(null);
        await clearToken();
        setMe(null);
      }
      // Offline: keep the last known plan; the server still enforces it.
    }
  }, [api]);

  useEffect(() => {
    void (async () => {
      const token = await loadToken();
      if (token) {
        api.setToken(token);
        await refreshMe();
      }
      setReady(true);
    })();
  }, [api, refreshMe]);

  const adoptToken = useCallback(
    async (token: string | null) => {
      api.setToken(token);
      if (token) {
        await saveToken(token);
        await refreshMe();
      } else {
        await clearToken();
        setMe(null);
      }
    },
    [api, refreshMe],
  );

  const detach = useCallback(async () => {
    dropUnsub.current?.();
    dropUnsub.current = null;
    const current = elm;
    setElm(null);
    setLink(null);
    await current?.close().catch(() => undefined);
  }, [elm]);

  const signOut = useCallback(async () => {
    await detach();
    api.setToken(null);
    await clearToken();
    setMe(null);
  }, [api, detach]);

  const attach = useCallback(
    async (transport: Transport) => {
      await detach();
      const driver = new Elm327(transport);
      try {
        const info = await driver.init();
        dropUnsub.current = transport.onDisconnect((why) => {
          setLinkLost(why);
          setLink(null);
          setElm(null);
        });
        setLinkLost(null);
        setElm(driver);
        setLink({ label: transport.label, info });
      } catch (e) {
        await driver.close().catch(() => undefined);
        throw e;
      }
    },
    [detach],
  );

  const value: AppState = { api, ready, me, adoptToken, signOut, refreshMe, elm, link, linkLost, attach, detach };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}
