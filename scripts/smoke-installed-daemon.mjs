#!/usr/bin/env node
// Post-install smoke test for an installed edge daemon (Task 5.1 gate), run by
// .github/workflows/package.yml on Linux and Windows against the real service:
//
//   node scripts/smoke-installed-daemon.mjs [--port 8765] [--pair-code 123456]
//        [--log <daemon log file>] [--expect-origin https://app.rootcauseobd.com.au]
//
// Checks that the daemon listens on loopback only, refuses connections from a
// non-loopback address, refuses an unpaired client and a wrong code, accepts a
// pairing code made by `edge-daemon pair` (when --pair-code is given), refuses
// WebSocket handshakes from any origin but production, and started with exactly
// the production origin (when --log is given). Exit 0 = pass.
// Needs Node 22+ (global WebSocket).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, platform } from "node:os";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port ?? 8765);
const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(what);
};

/** Local addresses listening on PORT, e.g. ["127.0.0.1", "::1"]. */
function listeners() {
  if (platform() === "win32") {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }) +
      execFileSync("netstat", ["-ano", "-p", "TCPv6"], { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f[0] === "TCP" && f[3] === "LISTENING" && f[1].endsWith(`:${PORT}`))
      .map((f) => f[1].slice(0, f[1].lastIndexOf(":")).replace(/^\[|\]$/g, ""));
  }
  // Linux: /proc/net/tcp{,6}, state 0A = LISTEN; addresses are little-endian hex words.
  const word = (h) => h.match(/../g).reverse().join("");
  const found = [];
  for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== "0A") continue;
      const [addr, port] = f[1].split(":");
      if (parseInt(port, 16) !== PORT) continue;
      if (!v6) {
        found.push(word(addr).match(/../g).map((b) => parseInt(b, 16)).join("."));
      } else {
        const hex = addr.match(/.{8}/g).map(word).join("");
        const groups = hex.match(/.{4}/g).map((g) => parseInt(g, 16).toString(16));
        found.push(groups.join(":").replace(/(^|:)0(:0)+(:|$)/, "::").replace(/:{3,}/, "::"));
      }
    }
  }
  return found;
}

function tcpRefused(host) {
  return new Promise((resolve) => {
    const s = connect({ host, port: PORT, timeout: 3000 });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(true));
  });
}

/** Sends one message and returns the first reply (or how the socket ended). */
function exchange(message) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const done = (r) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ended: "timeout" }), 8000);
    ws.addEventListener("open", () => ws.send(JSON.stringify(message)));
    ws.addEventListener("message", (e) => done(JSON.parse(e.data)));
    ws.addEventListener("error", () => done({ ended: "error" }));
    ws.addEventListener("close", (e) => done({ ended: `close ${e.code}` }));
  });
}

const versions = (() => {
  const root = new URL("..", import.meta.url);
  const ws = JSON.parse(readFileSync(new URL("packages/schemas/edge_ws.schema.json", root), "utf8"));
  const policy = JSON.parse(readFileSync(new URL("packages/schemas/safety_policy.json", root), "utf8"));
  return { protocol_version: ws["x-protocol-version"], policy_version: policy.policy_version };
})();
const hello = (token) => ({
  type: "HelloRequest",
  request_id: "smoke-hello",
  client_token: token,
  client_version: "0.0.0",
  ...versions,
});

/** The HTTP status a WebSocket upgrade from `origin` gets (101 = accepted). */
function upgradeStatus(origin) {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port: PORT,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        Host: `127.0.0.1:${PORT}`,
        Origin: origin,
      },
      timeout: 5000,
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (e) => resolve(`error ${e.code ?? e.message}`));
    req.end();
  });
}

// 0. The service may report "running" a moment before the port is bound.
for (let i = 0; i < 30 && listeners().length === 0; i++) await new Promise((r) => setTimeout(r, 500));

// 1. Loopback only.
const addrs = listeners();
check(addrs.length > 0, `daemon listens on port ${PORT}`, addrs.join(", ") || "nothing listening");
const loopback = new Set(["127.0.0.1", "::1"]);
check(addrs.every((a) => loopback.has(a)), "listens on loopback addresses only", addrs.join(", "));

// 2. Not reachable from another address of this machine.
const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal);
if (lan) check(await tcpRefused(lan.address), `refuses connections to ${lan.address}:${PORT}`);
else console.log("SKIP no non-loopback IPv4 address to test from");

// 3. Unpaired clients are refused.
const noHello = await exchange({ type: "AdapterListRequest", request_id: "smoke-1" });
check(noHello.code === "UNAUTHENTICATED", "refuses a client that skips HelloRequest", JSON.stringify(noHello));
const wrong = await exchange(hello("000000"));
check(wrong.code === "UNAUTHENTICATED", "refuses a wrong pairing code", JSON.stringify(wrong));

// 4. A code from `edge-daemon pair` is accepted (shared data folder works).
if (args["pair-code"]) {
  const ok = await exchange(hello(args["pair-code"]));
  check(ok.type === "HelloResponse", "accepts a code from `edge-daemon pair`", JSON.stringify(ok));
}

// 5. Trusts the production origin only: the handshake itself, and the startup log.
const want = args["expect-origin"] ?? "https://app.rootcauseobd.com.au";
for (const bad of ["http://localhost:3000", "http://127.0.0.1:3000", "https://evil.example"]) {
  const status = await upgradeStatus(bad);
  check(status !== 101, `refuses a WebSocket from ${bad}`, String(status));
}
const good = await upgradeStatus(want);
check(good === 101, `accepts a WebSocket from ${want}`, String(good));
if (args.log) {
  const line = readFileSync(args.log, "utf8")
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.includes("edge-daemon listening"));
  const origins = line?.match(/origins=(.*?) data=/)?.[1]?.split(", ") ?? [];
  check(origins.length === 1 && origins[0] === want, `allowed origins are exactly ${want}`, line ?? "no startup line");
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nInstalled daemon smoke test passed");
