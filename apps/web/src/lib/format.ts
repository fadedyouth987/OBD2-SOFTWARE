import { DISPLAY_TIME_ZONE } from "@/lib/config";

const dateTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const timeOnly = new Intl.DateTimeFormat("en-AU", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

const dateOnly = new Intl.DateTimeFormat("en-AU", {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "25 Nov 2026, 1:05 pm ACDT" in the workshop's zone. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dateTime.format(d) : "—";
}

export function formatTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? timeOnly.format(d) : "—";
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dateOnly.format(d) : "—";
}

/** "in 3 h 12 min", "5 min ago". */
export function relative(value: string | number | Date | null | undefined, now = Date.now()): string {
  const d = toDate(value);
  if (!d) return "—";
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  let text: string;
  if (mins < 1) text = "less than a minute";
  else if (mins < 60) text = `${mins} min`;
  else if (mins < 60 * 48) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    text = m && h < 10 ? `${h} h ${m} min` : `${h} h`;
  } else text = `${Math.round(mins / 1440)} days`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A sensor reading with sensible precision for its magnitude. */
export function formatReading(value: number): string {
  // Whole numbers (0 rpm, 20 °C) read better without trailing zeros.
  if (Number.isInteger(value)) return formatNumber(value, 0);
  const a = Math.abs(value);
  return formatNumber(value, a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

/** Plain-English label for a guided-step safety tier ("SILENT", "TIER A", "TIER A / B"). */
export function safetyTierLabel(tier: string): { label: string; tone: "ok" | "warn" } {
  const t = tier.trim().toUpperCase().replace(/_/g, " ");
  if (t === "SILENT" || t === "READ ONLY") return { label: "Read-only", tone: "ok" };
  const parts = t.replace(/^TIER\s*/, "").split(/\s*\/\s*/).map((p) => p.replace(/^TIER\s*/, ""));
  return { label: `Confirm · Tier ${parts.join("/")}`, tone: "warn" };
}
