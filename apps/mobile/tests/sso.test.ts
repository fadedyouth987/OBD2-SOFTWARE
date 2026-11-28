import { bytesToBase64url, parseCallback, runSso, type SsoDeps } from "../src/auth/sso";
import { createHash } from "node:crypto";

function deps(over: Partial<SsoDeps> & { responses: Record<string, { status: number; body: unknown }> }): SsoDeps & { calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  return {
    calls,
    apiUrl: "https://api.example.com",
    fetch: (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body });
      const key = Object.keys(over.responses).find((k) => url.includes(k))!;
      const r = over.responses[key];
      return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) } as Response;
    }) as unknown as typeof fetch,
    randomBytes: (n) => new Uint8Array(n).fill(7),
    sha256Base64: async (s) => createHash("sha256").update(s).digest("base64"),
    openAuthSession: over.openAuthSession ?? (async () => ({ type: "success", url: "rootcause://auth/callback?code=c1&state=m.s1" })),
  };
}

describe("provider sign-in from the app", () => {
  it("sends a S256 challenge and redeems with the verifier", async () => {
    const d = deps({
      responses: {
        "/oidc/start": { status: 200, body: { authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } },
        "/oidc/callback": { status: 200, body: { access_token: "tok", return_to: "/" } },
      },
    });
    const r = await runSso(d, { returnTo: "/jobs" });
    expect(r).toEqual({ kind: "signed-in", token: "tok", returnTo: "/home" });
    const verifier = bytesToBase64url(new Uint8Array(32).fill(7));
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(d.calls[0].url).toContain(`client_challenge=${challenge}`);
    expect(d.calls[0].url).toContain("return_to=%2Fjobs");
    expect(JSON.parse(d.calls[1].body!)).toEqual({ code: "c1", state: "m.s1", client_verifier: verifier });
  });

  it("passes an account link request to the web", async () => {
    const detail = { code: "link_required", link_token: "lt", provider: "Google", email_sent: true, email_hint: "j***@x.com" };
    const d = deps({
      responses: {
        "/oidc/start": { status: 200, body: { authorize_url: "https://p/a" } },
        "/oidc/callback": { status: 409, body: { detail } },
      },
    });
    expect(await runSso(d)).toEqual({ kind: "link-required", detail });
  });

  it("treats a closed browser as cancelled and refuses non-app states", async () => {
    const start = { "/oidc/start": { status: 200, body: { authorize_url: "https://p/a" } } };
    expect(await runSso(deps({ responses: start, openAuthSession: async () => ({ type: "dismiss" }) }))).toEqual({ kind: "cancelled" });
    const web = deps({ responses: start, openAuthSession: async () => ({ type: "success", url: "rootcause://auth/callback?code=c&state=web" }) });
    expect((await runSso(web)).kind).toBe("failed");
    expect(web.calls).toHaveLength(1); // never redeemed
  });

  it("parses only rootcause://auth/callback with an app state", () => {
    expect(parseCallback("rootcause://auth/callback?code=a&state=m.b")).toEqual({ code: "a", state: "m.b" });
    expect(parseCallback("https://evil/auth/callback?code=a&state=m.b")).toBeNull();
    expect(parseCallback("rootcause://auth/callback?code=a")).toBeNull();
  });

  it("base64url matches Node", () => {
    for (const n of [1, 2, 3, 31, 32, 33]) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
      expect(bytesToBase64url(b)).toBe(Buffer.from(b).toString("base64url"));
    }
  });
});
