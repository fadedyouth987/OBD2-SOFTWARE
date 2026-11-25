"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, cx } from "@/components/ui";
import { Menu, MenuItem } from "@/components/shell/Menu";
import { useTheme } from "@/components/shell/theme";
import { useActiveJob } from "@/context/active-job";
import { useAuth } from "@/context/auth";
import { useEdge } from "@/context/edge";
import { ROLE_LABEL, type TeamRole } from "@/lib/api";
import { APP_NAME } from "@/lib/config";
import { TIER_LABEL } from "@/lib/entitlements";
import { formatDateTime, relative } from "@/lib/format";

const NAV = [
  { href: "/home", label: "Home", icon: "⌂" },
  { href: "/jobs", label: "Vehicles & jobs", icon: "▤" },
  { href: "/devices", label: "Devices", icon: "⎔" },
  { href: "/key-programming", label: "Key programming", icon: "⚿" },
  { href: "/knowledge", label: "Knowledge", icon: "❖" },
  { href: "/workshop", label: "Workshop", icon: "⚙" },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="space-y-1">
        {NAV.map((item) => {
          const active = path === item.href || path.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex min-h-[44px] items-center gap-3 rounded-lg px-3 text-sm font-semibold",
                  active ? "bg-raised text-text shadow-[inset_3px_0_0_var(--accent)]" : "text-muted hover:bg-raised hover:text-text",
                )}
              >
                <span aria-hidden className="w-4 text-center">
                  {item.icon}
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function WorkshopSwitcher() {
  const { me, switchWorkspace } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (!me) return null;
  const label = (
    <span className="flex min-w-0 flex-col items-start leading-tight">
      <span className="max-w-[160px] truncate">{me.workspace.name}</span>{" "}
      <span className="text-[11px] font-normal text-muted">{(ROLE_LABEL[me.workspace.role as TeamRole] ?? me.workspace.role).toLowerCase()}</span>
      <span className="sr-only">. Switch workshop</span>
    </span>
  );
  return (
    <Menu label="" button={label} align="left">
      {(close) => (
        <div>
          <p className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Workshops</p>
          {me.workspaces.map((w) => (
            <MenuItem
              key={w.tenant_id}
              disabled={w.tenant_id === me.workspace.tenant_id}
              onSelect={async () => {
                try {
                  await switchWorkspace(w.tenant_id);
                  close();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't switch workshop.");
                }
              }}
            >
              <span className="flex-1 truncate">{w.name}</span>
              <span className="text-xs text-muted">{TIER_LABEL[w.tier] ?? w.tier}</span>
              {w.tenant_id === me.workspace.tenant_id ? <span aria-label="current">✓</span> : null}
            </MenuItem>
          ))}
          {error ? <p className="px-2.5 py-1 text-xs text-danger-ink">{error}</p> : null}
        </div>
      )}
    </Menu>
  );
}

function VehicleChip() {
  const { active } = useActiveJob();
  if (!active) {
    return (
      <Link href="/jobs/new" className="hidden min-h-[40px] items-center rounded-lg border border-dashed border-line px-2.5 text-xs text-muted hover:text-text md:inline-flex">
        No vehicle · Start a job
      </Link>
    );
  }
  return (
    <Link
      href={`/jobs/${active.id}`}
      className="hidden min-h-[40px] max-w-[240px] flex-col justify-center rounded-lg border border-line bg-raised px-2.5 text-xs leading-tight hover:border-muted md:flex"
      title="Open the active job"
    >
      <span className="truncate font-semibold">{active.vehicle_label || "Unnamed vehicle"}</span>
      <span className="truncate font-mono text-[11px] text-muted">
        {active.vin_redacted ?? "VIN not read"} {active.status === "CLOSED" ? "· closed" : ""}
      </span>
    </Link>
  );
}

function DeviceChip() {
  const { snapshot, link, mode } = useEdge();
  let tone = "bg-faint";
  let text = "Daemon";
  let sub = "";
  if (snapshot.phase === "ready") {
    if (link?.state === "CONNECTED") {
      tone = "bg-ok";
      text = link.adapter?.display_name ?? link.adapterId;
      sub = link.batteryV !== null ? `${link.batteryV.toFixed(1)} V` : "connected";
    } else if (link?.state === "CONNECTING") {
      tone = "bg-warn";
      text = "Connecting adapter…";
    } else {
      tone = "bg-blue";
      text = mode === "browser-sim" ? "Browser demo" : `Daemon ${snapshot.hello?.daemon_version ?? ""}`;
      sub = "no adapter";
    }
  } else if (snapshot.phase === "failed") {
    tone = "bg-danger";
    text = snapshot.failure?.needsCode ? "Pairing needed" : "Daemon problem";
  } else if (snapshot.phase === "waiting") {
    tone = "bg-danger";
    text = "Daemon offline";
    sub = "retrying";
  } else {
    tone = "bg-warn";
    text = "Connecting…";
  }
  return (
    <Link
      href="/devices"
      className="flex min-h-[40px] max-w-[220px] items-center gap-2 rounded-lg border border-line bg-raised px-2.5 text-xs hover:border-muted"
    >
      <span aria-hidden className={cx("h-2.5 w-2.5 shrink-0 rounded-full", tone)} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-semibold">{text}</span>{" "}
        {sub ? <span className="truncate text-[11px] text-muted">{sub}</span> : null}
        <span className="sr-only">. Open Devices</span>
      </span>
      {mode === "browser-sim" ? <Badge tone="warn">DEMO</Badge> : null}
    </Link>
  );
}

function LeaseChip() {
  const { lease, ready } = useEdge();
  if (!ready || !lease) return null;
  const exp = lease.expires_at ? new Date(lease.expires_at) : null;
  const soon = exp && exp.getTime() - Date.now() < 6 * 3600_000;
  return (
    <Link
      href="/devices#lease"
      className="hidden min-h-[40px] flex-col justify-center rounded-lg border border-line bg-raised px-2.5 text-xs leading-tight hover:border-muted lg:flex"
      title={exp ? `Offline lease ends ${formatDateTime(exp)}` : "Built-in Community lease"}
    >
      <span className="font-semibold">Lease: {TIER_LABEL[lease.lease_tier]}</span>
      <span className={cx("text-[11px]", soon ? "text-warn" : "text-muted")}>
        {exp ? `ends ${relative(exp)}` : "read-only, no expiry"}
      </span>
    </Link>
  );
}

function SafetyBadge() {
  const { link } = useEdge();
  if (!link || link.state !== "CONNECTED") return null;
  return link.safetyMode === "ACTIVE_CONFIRMED" ? (
    <Badge tone="warn" className="hidden sm:inline-flex">
      Active (confirmed)
    </Badge>
  ) : (
    <Badge tone="ok" className="hidden sm:inline-flex">
      Silent (read-only)
    </Badge>
  );
}

function UsageChip() {
  const { me } = useAuth();
  if (!me) return null;
  const used = me.usage.ai_diagnoses_used;
  const limit = me.entitlements.ai_diagnoses;
  const pct = limit ? used / limit : 1;
  return (
    <Link
      href="/workshop/billing"
      className="hidden min-h-[40px] flex-col justify-center rounded-lg border border-line bg-raised px-2.5 text-xs leading-tight hover:border-muted xl:flex"
      title="Plan and usage"
    >
      <span className="font-semibold">{TIER_LABEL[me.entitlements.tier]} plan</span>
      <span className={cx("tabular text-[11px]", pct >= 1 ? "text-danger-ink" : pct >= 0.8 ? "text-warn" : "text-muted")}>
        AI {used}/{limit} this month
      </span>
    </Link>
  );
}

function UserMenu() {
  const { me, signOut } = useAuth();
  const { daylight, toggle } = useTheme();
  const router = useRouter();
  const name = me?.user.display_name || me?.user.email || "Account";
  return (
    <Menu
      label={`Account: ${name}`}
      button={
        <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
          {name.slice(0, 1).toUpperCase()}
        </span>
      }
    >
      {(close) => (
        <div>
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-xs text-muted">{me?.user.email}</p>
            <p className="mt-1 text-xs text-muted">
              {me ? (ROLE_LABEL[me.workspace.role as TeamRole] ?? me.workspace.role).toLowerCase() : ""} at {me?.workspace.name}
            </p>
          </div>
          <MenuItem
            onSelect={() => {
              toggle();
              close();
            }}
          >
            {daylight ? "Switch to night mode" : "Switch to daylight mode"}
          </MenuItem>
          <MenuItem
            onSelect={() => {
              close();
              signOut();
              router.replace("/signin");
            }}
          >
            Sign out
          </MenuItem>
        </div>
      )}
    </Menu>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "Tab" && panel.current) {
        const items = panel.current.querySelectorAll<HTMLElement>("a,button");
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("a")?.focus();
    const btn = opener.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      btn?.focus();
    };
  }, [open]);
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-line bg-raised lg:hidden"
      >
        ☰
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div ref={panel} className="absolute inset-y-0 left-0 w-72 border-r border-line bg-panel p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-extrabold">{APP_NAME}</span>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="Close menu">
                ✕
              </Button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function GlobalBanners() {
  const { offline, error, me } = useAuth();
  const { snapshot, mode, setMode } = useEdge();
  const grace = me?.entitlements.billing_grace_until;
  return (
    <div className="space-y-2 empty:hidden">
      {offline ? (
        <Banner tone="warn" title="Working offline">
          {error ?? "The cloud can't be reached."} Vehicle reading keeps working; saving jobs and AI need the connection.
        </Banner>
      ) : null}
      {mode === "browser-sim" ? (
        <Banner
          tone="warn"
          title="Browser demo"
          action={
            <Button size="sm" onClick={() => setMode("daemon")}>
              Use the real daemon
            </Button>
          }
        >
          Readings come from a demo car simulated in this browser, not from a vehicle or the edge daemon.
        </Banner>
      ) : null}
      {snapshot.versionNote ? <Banner tone="info">{snapshot.versionNote}</Banner> : null}
      {snapshot.failure?.kind === "version" ? (
        <Banner tone="danger" title="App and daemon versions don't match">
          {snapshot.failure.message} {snapshot.failure.hint}
        </Banner>
      ) : null}
      {me && me.entitlements.billing_status === "past_due" ? (
        <Banner tone="danger" title="Payment overdue" action={<Link className="text-sm font-semibold underline" href="/workshop/billing">Fix billing</Link>}>
          {grace
            ? `Paid features stay on until ${formatDateTime(grace)}, then the workshop drops to Community.`
            : "Paid features are paused until billing is fixed."}
        </Banner>
      ) : null}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-panel focus:p-2">
        Skip to content
      </a>
      <aside className="no-print hidden border-r border-line bg-panel p-4 lg:block">
        <Link href="/home" className="mb-6 flex items-center gap-2 px-1">
          <span aria-hidden className="h-6 w-1.5 rounded bg-accent" />
          <span className="text-sm font-extrabold tracking-tight">{APP_NAME}</span>
        </Link>
        <NavLinks />
      </aside>
      <div className="min-w-0">
        <header className="no-print sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
          <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
            <MobileNav />
            <WorkshopSwitcher />
            <VehicleChip />
            <div className="ml-auto flex items-center gap-2">
              <DeviceChip />
              <LeaseChip />
              <SafetyBadge />
              <UsageChip />
              <UserMenu />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-6 sm:py-6">
          <GlobalBanners />
          {children}
        </main>
      </div>
    </div>
  );
}
