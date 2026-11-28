import { decideNavigation } from "../src/web/policy";
import { adoptSessionScript, bootstrapScript, parseBridgeMessage, pendingLinkScript } from "../src/web/bridge";

const APP = "https://app.rootcauseobd.com.au";

describe("what the web view may load", () => {
  it("allows the RootCause web app only", () => {
    expect(decideNavigation(`${APP}/jobs/1`, APP)).toEqual({ action: "allow" });
    expect(decideNavigation("about:blank", APP)).toEqual({ action: "allow" });
    expect(decideNavigation("https://app.rootcauseobd.com.au.evil.com/", APP).action).toBe("external");
    expect(decideNavigation("http://app.rootcauseobd.com.au/", APP).action).toBe("external"); // not the https origin
  });

  it("never loads Stripe Checkout or the billing portal (Play rules)", () => {
    for (const u of ["https://checkout.stripe.com/c/pay/cs_1", "https://billing.stripe.com/p/session/x", "https://buy.stripe.com/x"]) {
      expect(decideNavigation(u, APP)).toEqual({ action: "block", reason: "purchase" });
    }
  });

  it("opens other sites and mail/phone links outside the app", () => {
    expect(decideNavigation("https://docs.example.com/x", APP)).toEqual({ action: "external", url: "https://docs.example.com/x" });
    expect(decideNavigation("mailto:help@example.com", APP).action).toBe("external");
    expect(decideNavigation("intent://scan#Intent;end", APP)).toEqual({ action: "block", reason: "scheme" });
    expect(decideNavigation("javascript:alert(1)", APP)).toEqual({ action: "block", reason: "scheme" });
    expect(decideNavigation("file:///data/x", APP)).toEqual({ action: "block", reason: "scheme" });
  });
});

describe("the bridge", () => {
  const from = `${APP}/devices`;

  it("only listens to the RootCause origin", () => {
    expect(parseBridgeMessage('{"type":"open-dongle"}', "https://evil.example/", APP)).toBeNull();
    expect(parseBridgeMessage('{"type":"open-dongle"}', from, APP)).toEqual({ type: "open-dongle" });
  });

  it("accepts only known shapes, with same-site return paths", () => {
    expect(parseBridgeMessage("not json", from, APP)).toBeNull();
    expect(parseBridgeMessage('{"type":"run-shell"}', from, APP)).toBeNull();
    expect(parseBridgeMessage('{"type":"sso-start","returnTo":"//evil.com"}', from, APP)).toEqual({ type: "sso-start" });
    expect(parseBridgeMessage('{"type":"sso-start","returnTo":"/jobs/1"}', from, APP)).toEqual({ type: "sso-start", returnTo: "/jobs/1" });
    expect(parseBridgeMessage('{"type":"session","token":5}', from, APP)).toEqual({ type: "session", token: null });
  });

  it("scripts quote what they insert", () => {
    const evil = '");alert(1);("';
    expect(adoptSessionScript(evil, "/home")).toContain(JSON.stringify(evil));
    expect(adoptSessionScript("t", "https://evil.com")).toContain('location.replace("/home")');
    expect(pendingLinkScript({ link_token: "x" })).toContain("/signin?link=1");
    expect(bootstrapScript("1.2.3")).toContain('appVersion:"1.2.3"');
  });
});
