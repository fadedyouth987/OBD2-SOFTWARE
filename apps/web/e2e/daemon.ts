// A real edge daemon for the Task 4.1 gate: the debug build on the virtual
// vehicles, with a throwaway cloud key pinned through EDGE_DEV_CLOUD_KEYS, and
// pairing and lease tokens issued by the cloud's own signing.py with that key.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EdgeTokens } from "./fixtures";

const ROOT = resolve(__dirname, "../../..");
const CLOUD_API = join(ROOT, "services/cloud-api");
export const DAEMON_BIN = join(ROOT, "target/debug/edge-daemon");
/** The port the production build connects to (NEXT_PUBLIC_EDGE_WS_URL default). */
export const DAEMON_PORT = 8765;

/** Versions the browser announces in HelloRequest, read from the shared schemas. */
export function wireVersions(): { protocol: string; policy: string } {
  const schemas = join(ROOT, "packages/schemas");
  const ws = JSON.parse(readFileSync(join(schemas, "edge_ws.schema.json"), "utf8"));
  const policy = JSON.parse(readFileSync(join(schemas, "safety_policy.json"), "utf8"));
  return { protocol: ws["x-protocol-version"], policy: policy.policy_version };
}

export function daemonAvailable(): boolean {
  return existsSync(DAEMON_BIN);
}

function python(): [string, string[]] {
  const venv = join(CLOUD_API, ".venv/bin/python");
  return existsSync(venv) ? [venv, []] : ["uv", ["run", "--no-sync", "python"]];
}

export class CloudSigner implements EdgeTokens {
  private readonly env: NodeJS.ProcessEnv;

  constructor(origin: string) {
    this.env = {
      ...process.env,
      // TEST ONLY: a fresh key per run, pinned only in this test's debug daemon.
      CLOUD_SIGNING_PRIVATE_KEY_HEX: randomBytes(32).toString("hex"),
      CLOUD_SIGNING_KID: `e2e-${randomBytes(4).toString("hex")}`,
      E2E_TENANT: "t1",
      E2E_USER: "u1",
      E2E_ORIGIN: origin,
    };
  }

  private issue(what: "key" | "pairing" | "lease"): Record<string, unknown> {
    const [cmd, pre] = python();
    const out = execFileSync(cmd, [...pre, "-m", "tests.edge_e2e_tokens", what], {
      cwd: CLOUD_API,
      env: this.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    return JSON.parse(out.trim().split("\n").pop()!);
  }

  keys(): string {
    return this.issue("key").keys as string;
  }

  pairing = (): string => this.issue("pairing").token as string;

  lease = (): unknown => this.issue("lease");
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      ok(true);
    });
    s.once("error", () => ok(false));
  });
}

async function waitFor(cond: () => Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export class Daemon {
  readonly dataDir = mkdtempSync(join(tmpdir(), "edge-gate-"));
  private proc: ChildProcess | null = null;
  log = "";

  constructor(
    private readonly origin: string,
    private readonly keys: string,
  ) {}

  async start(env: Record<string, string> = {}) {
    if (await portOpen(DAEMON_PORT)) {
      throw new Error(`something is already listening on 127.0.0.1:${DAEMON_PORT}; stop it before the daemon gate`);
    }
    // EDGE_* left in a developer's shell (a fault, another data dir) never leaks in.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(childEnv)) if (k.startsWith("EDGE_")) delete childEnv[k];
    Object.assign(childEnv, {
      EDGE_PORT: String(DAEMON_PORT),
      EDGE_DATA_DIR: this.dataDir,
      EDGE_ALLOWED_ORIGINS: this.origin,
      EDGE_LOG_FILE: "off",
      EDGE_DEV_CLOUD_KEYS: this.keys,
      RUST_LOG: "info",
      ...env,
    });
    this.proc = spawn(DAEMON_BIN, ["serve"], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (b: Buffer) => {
      this.log = (this.log + b.toString()).slice(-20_000);
    };
    this.proc.stdout?.on("data", keep);
    this.proc.stderr?.on("data", keep);
    let failed = null as Error | null;
    this.proc.once("error", (e) => (failed = e));
    this.proc.once("exit", (code, signal) => {
      failed ??= new Error(`the daemon exited early (code ${code}, signal ${signal}):\n${this.log}`);
    });
    await waitFor(async () => {
      if (failed) throw failed;
      return portOpen(DAEMON_PORT);
    }, "the daemon to listen");
  }

  /** Kills the process outright (no graceful shutdown) and waits for the port to close. */
  async kill() {
    this.proc?.kill("SIGKILL");
    this.proc = null;
    await waitFor(async () => !(await portOpen(DAEMON_PORT)), "the daemon port to close");
  }

  /** Lines of the daemon's own gated-command audit log (A-CEO-4). */
  audit(): Record<string, unknown>[] {
    const file = join(this.dataDir, "audit.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  async stop() {
    if (this.proc) await this.kill();
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}
