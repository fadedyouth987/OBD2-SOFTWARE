import { afterEach, describe, expect, it, vi } from "vitest";
import { appHandoffUrl, nativeApp, postToNative } from "@/lib/native";

describe("Android app bridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is off in a normal browser", () => {
    vi.stubGlobal("window", {});
    expect(nativeApp()).toBeNull();
    expect(postToNative({ type: "open-dongle" })).toBe(false);
  });

  it("posts JSON to the app when both halves of the bridge are there", () => {
    const sent: string[] = [];
    vi.stubGlobal("window", {
      RootCauseNative: { platform: "android", appVersion: "0.2.0" },
      ReactNativeWebView: { postMessage: (m: string) => sent.push(m) },
    });
    expect(nativeApp()?.platform).toBe("android");
    expect(postToNative({ type: "sso-start", returnTo: "/home" })).toBe(true);
    expect(JSON.parse(sent[0])).toEqual({ type: "sso-start", returnTo: "/home" });
  });

  it("a page can't fake the bridge with only the flag", () => {
    vi.stubGlobal("window", { RootCauseNative: { platform: "android", appVersion: "x" } });
    expect(nativeApp()).toBeNull();
  });

  it("hands only app-started sign-ins back to the app", () => {
    expect(appHandoffUrl("c1", "m.abc")).toBe("rootcause://auth/callback?code=c1&state=m.abc");
    expect(appHandoffUrl("c1", "abc")).toBeNull();
  });
});
