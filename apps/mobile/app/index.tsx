// The app's main screen is the RootCause web app itself, so the phone shows exactly
// the same pages, navigation and plan gates as the website (they're the same code,
// reading the same /auth/me entitlements and daemon lease). The app adds:
//  - provider sign-in in the phone's browser (Google refuses embedded web views),
//  - the phone's own Bluetooth dongle, read-only (Devices → "Use a dongle with this phone"),
//  - no purchases in the app: Stripe pages never load here (Google Play rules),
//  - a pinned TLS link to the workshop PC's edge daemon (Devices → Pair with a PC),
//    so the web app's daemon connection works from the phone (src/lan).
// Anything that changes a car still goes through the edge daemon and its safety
// interlock, hold-to-confirm and audit log, exactly as from the PC's browser.

import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, BackHandler, Linking, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView as RNWebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import type { AndroidWebViewProps } from "react-native-webview/lib/WebViewTypes";

// The package's combined iOS/Android/Windows prop type collapses to `never` with
// these React types; this app is Android-only, so use the Android props.
interface WebViewHandle {
  goBack(): void;
  injectJavaScript(script: string): void;
}
const WebView = RNWebView as unknown as React.ComponentType<AndroidWebViewProps & React.RefAttributes<WebViewHandle>>;
import { runSso } from "../src/auth/sso";
import { API_URL, APP_URL, APP_VERSION, CONFIG_ERROR } from "../src/config";
import { DaemonLink } from "../modules/daemon-link";
import { DaemonRelay } from "../src/lan/relay";
import { hasDaemonLink, pcStore } from "../src/lan/pc";
import { publicInfo, type PairedPc } from "../src/lan/store";
import { useApp } from "../src/state";
import { Banner, Button, color } from "../src/ui/kit";
import {
  adoptSessionScript,
  bootstrapScript,
  daemonUpdateScript,
  parseBridgeMessage,
  pendingLinkScript,
  READ_SESSION_SCRIPT,
  signInErrorScript,
} from "../src/web/bridge";
import { decideNavigation } from "../src/web/policy";

export default function WebApp() {
  const web = useRef<WebViewHandle>(null);
  const { adoptToken } = useApp();
  const [canGoBack, setCanGoBack] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);
  const wantDongle = useRef(false);

  // The paired workshop PC (undefined until secure storage has been read).
  const [pc, setPc] = useState<PairedPc | null | undefined>(pcStore.current());
  const relay = useRef<DaemonRelay | null>(null);
  useEffect(() => {
    if (!hasDaemonLink) {
      setPc(null);
      return;
    }
    relay.current = new DaemonRelay({
      native: DaemonLink,
      inject: (script) => web.current?.injectJavaScript(script),
      pc: () => pcStore.current(),
      origin: new URL(APP_URL).origin,
    });
    void pcStore.load().then(setPc);
    const unsub = pcStore.subscribe((next) => {
      // A different (or no) PC: drop connections to the old one, then tell the web app.
      relay.current?.closeAll(null);
      setPc(next);
      web.current?.injectJavaScript(daemonUpdateScript(publicInfo(next)));
    });
    return () => {
      unsub();
      relay.current?.dispose();
      relay.current = null;
    };
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack) {
        web.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  const sso = useCallback(async (returnTo?: string, inviteToken?: string) => {
    setSsoBusy(true);
    try {
      const result = await runSso(
        {
          apiUrl: API_URL,
          fetch,
          randomBytes: (n) => Crypto.getRandomBytes(n),
          sha256Base64: (input) =>
            Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, { encoding: Crypto.CryptoEncoding.BASE64 }),
          openAuthSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect, { showInRecents: false }),
        },
        { returnTo, inviteToken },
      );
      if (result.kind === "signed-in") web.current?.injectJavaScript(adoptSessionScript(result.token, result.returnTo));
      else if (result.kind === "link-required") web.current?.injectJavaScript(pendingLinkScript(result.detail));
      else if (result.kind === "failed") web.current?.injectJavaScript(signInErrorScript(result.message));
    } finally {
      setSsoBusy(false);
    }
  }, []);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const msg = parseBridgeMessage(e.nativeEvent.data, e.nativeEvent.url, APP_URL);
      if (!msg) return;
      if (msg.type === "sso-start") void sso(msg.returnTo, msg.inviteToken);
      else if (msg.type === "open-dongle") {
        wantDongle.current = true;
        web.current?.injectJavaScript(READ_SESSION_SCRIPT);
      } else if (msg.type === "session") {
        void adoptToken(msg.token).then(() => {
          if (wantDongle.current) {
            wantDongle.current = false;
            router.push("/dongle");
          }
        });
      } else if (msg.type === "signed-out") void adoptToken(null);
      else if (msg.type === "open-external") {
        const d = decideNavigation(msg.url, APP_URL);
        if (d.action === "external") void Linking.openURL(d.url);
      } else if (msg.type === "daemon-open") relay.current?.openConnection(msg.id);
      else if (msg.type === "daemon-send") relay.current?.send(msg.id, msg.text);
      else if (msg.type === "daemon-close") relay.current?.closeConnection(msg.id);
      else if (msg.type === "lan-pair") {
        if (hasDaemonLink) router.push("/lan/pair");
      } else if (msg.type === "lan-forget") {
        Alert.alert(
          "Forget this PC?",
          "This phone stops connecting to it. Also remove the phone on the PC (Devices → Phone access) so its pairing can't be used again.",
          [
            { text: "Keep", style: "cancel" },
            { text: "Forget", style: "destructive", onPress: () => void pcStore.forget() },
          ],
        );
      }
    },
    [adoptToken, sso],
  );

  const onShouldStart = useCallback((req: WebViewNavigation) => {
    const d = decideNavigation(req.url, APP_URL);
    if (d.action === "allow") return true;
    if (d.action === "external") void Linking.openURL(d.url);
    else if (d.reason === "purchase") setNotice("Plans and payments are changed on the RootCause website from a computer.");
    return false;
  }, []);

  if (CONFIG_ERROR) {
    return (
      <SafeAreaView style={s.center}>
        <Text style={s.brand}>RootCause</Text>
        <Banner tone="danger" title="This build isn't set up">
          {CONFIG_ERROR}
        </Banner>
      </SafeAreaView>
    );
  }
  if (pc === undefined) {
    return (
      <SafeAreaView style={s.center}>
        <ActivityIndicator color={color.accent} />
      </SafeAreaView>
    );
  }
  if (failed) {
    return (
      <SafeAreaView style={s.center}>
        <Text style={s.brand}>RootCause</Text>
        <Banner tone="danger" title="Can't reach RootCause">
          {failed}
        </Banner>
        <Button
          label="Try again"
          onPress={() => {
            setFailed(null);
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen} edges={["top", "bottom", "left", "right"]}>
      {notice ? (
        <View style={s.notice}>
          <Banner tone="info" title="Not available in the app">
            {notice}
          </Banner>
          <Button kind="ghost" label="OK" onPress={() => setNotice(null)} />
        </View>
      ) : null}
      <WebView
        ref={web}
        source={{ uri: `${APP_URL}/home` }}
        style={{ backgroundColor: color.bg }}
        originWhitelist={[APP_URL]}
        injectedJavaScriptBeforeContentLoaded={bootstrapScript(APP_VERSION, hasDaemonLink ? publicInfo(pc) : undefined, __DEV__)}
        onLoadStart={() => relay.current?.closeAll(null)}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStart}
        onNavigationStateChange={(n) => setCanGoBack(n.canGoBack)}
        onError={(e) => setFailed(`${e.nativeEvent.description}. Check your connection.`)}
        domStorageEnabled
        javaScriptEnabled
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        webviewDebuggingEnabled={__DEV__}
        startInLoadingState
        renderLoading={() => (
          <View style={s.loading}>
            <ActivityIndicator color={color.accent} />
          </View>
        )}
        applicationNameForUserAgent={`RootCauseApp/${APP_VERSION}`}
      />
      {ssoBusy ? (
        <View style={s.loading} pointerEvents="none">
          <ActivityIndicator color={color.accent} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, backgroundColor: color.bg, padding: 16, gap: 16, justifyContent: "center" },
  brand: { color: color.text, fontSize: 22, fontWeight: "800", textAlign: "center" },
  loading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(12,15,20,0.6)" },
  notice: { padding: 12, gap: 8, backgroundColor: color.panel, borderBottomColor: color.line, borderBottomWidth: 1 },
});
