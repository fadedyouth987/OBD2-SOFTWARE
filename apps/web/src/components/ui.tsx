"use client";

import Link from "next/link";
import { forwardRef, useId } from "react";

export type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

const BUTTON_TONE: Record<string, string> = {
  primary: "bg-accent text-white hover:brightness-110 border-transparent",
  blue: "bg-blue text-white hover:brightness-110 border-transparent",
  secondary: "bg-raised text-text border-line hover:border-muted",
  danger: "bg-danger-soft text-danger-ink border-danger/50 hover:bg-danger/20",
  ghost: "bg-transparent text-muted border-transparent hover:text-text hover:bg-raised",
};

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_TONE;
  size?: "sm" | "md";
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", busy, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg border font-semibold transition disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "min-h-[36px] px-3 text-xs" : "min-h-[44px] px-4 text-sm",
        BUTTON_TONE[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner small /> : null}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: { href: string; variant?: keyof typeof BUTTON_TONE; size?: "sm" | "md"; className?: string; children: React.ReactNode } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg border font-semibold transition",
        size === "sm" ? "min-h-[36px] px-3 text-xs" : "min-h-[44px] px-4 text-sm",
        BUTTON_TONE[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

export function Spinner({ small, label }: { small?: boolean; label?: string }) {
  return (
    <span role={label ? "status" : undefined} className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className={cx(
          "inline-block animate-spin rounded-full border-2 border-current border-r-transparent",
          small ? "h-3.5 w-3.5" : "h-5 w-5",
        )}
      />
      {label ? <span className="text-sm text-muted">{label}</span> : null}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  id,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cx("rounded-xl border border-line bg-panel", className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-bold">{title}</h2> : null}
            {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

const BADGE_TONE: Record<Tone, string> = {
  neutral: "bg-raised text-muted border-line",
  ok: "bg-ok-soft text-ok border-ok/40",
  warn: "bg-warn-soft text-warn border-warn/40",
  danger: "bg-danger-soft text-danger-ink border-danger/40",
  info: "bg-blue-soft text-blue-ink border-blue/40",
  accent: "bg-accent text-white border-transparent",
};

const TONE_ICON: Record<Tone, string> = {
  neutral: "•",
  ok: "✓",
  warn: "!",
  danger: "✕",
  info: "i",
  accent: "•",
};

/** Severity is always icon + text + colour (A-DES-6). */
export function Badge({
  tone = "neutral",
  children,
  icon = true,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  icon?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold",
        BADGE_TONE[tone],
        className,
      )}
    >
      {icon ? (
        <span aria-hidden className="font-bold">
          {TONE_ICON[tone]}
        </span>
      ) : null}
      {children}
    </span>
  );
}

const BANNER_TONE: Record<Tone, string> = {
  neutral: "border-line bg-raised",
  ok: "border-ok/40 bg-ok-soft",
  warn: "border-warn/50 bg-warn-soft",
  danger: "border-danger/50 bg-danger-soft",
  info: "border-blue/40 bg-blue-soft",
  accent: "border-accent bg-raised",
};

export function Banner({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" || tone === "warn" ? "alert" : "status"}
      className={cx("flex flex-wrap items-start gap-3 rounded-lg border px-3 py-2.5 text-sm", BANNER_TONE[tone], className)}
    >
      <span aria-hidden className="mt-0.5 font-bold">
        {TONE_ICON[tone]}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cx("text-muted", title ? "mt-0.5" : "")}>{children}</div> : null}
      </div>
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

type FieldProps = {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
} & React.InputHTMLAttributes<HTMLInputElement>;

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={className}>
      <label htmlFor={fid} className="block text-xs font-semibold text-muted">
        {label}
      </label>
      <input
        ref={ref}
        id={fid}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${fid}-help` : undefined}
        className={cx(
          "mt-1 min-h-[44px] w-full rounded-lg border bg-bg px-3 text-sm text-text placeholder:text-faint",
          error ? "border-danger" : "border-line",
        )}
        {...rest}
      />
      {error || hint ? (
        <p id={`${fid}-help`} className={cx("mt-1 text-xs", error ? "text-danger-ink" : "text-faint")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
});

export function TextArea({
  label,
  hint,
  error,
  className,
  id,
  ...rest
}: { label: string; hint?: React.ReactNode; error?: string | null } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={className}>
      <label htmlFor={fid} className="block text-xs font-semibold text-muted">
        {label}
        {rest.required ? <span className="text-danger-ink"> *</span> : null}
      </label>
      <textarea
        id={fid}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${fid}-help` : undefined}
        className={cx(
          "mt-1 min-h-[88px] w-full rounded-lg border bg-bg px-3 py-2 text-sm text-text placeholder:text-faint",
          error ? "border-danger" : "border-line",
        )}
        {...rest}
      />
      {error || hint ? (
        <p id={`${fid}-help`} className={cx("mt-1 text-xs", error ? "text-danger-ink" : "text-faint")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  hint,
  className,
  id,
  children,
  hideLabel,
  options,
  ...rest
}: {
  label: string;
  hint?: React.ReactNode;
  hideLabel?: boolean;
  options?: { value: string; label: string }[];
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className={className}>
      <label htmlFor={fid} className={hideLabel ? "sr-only" : "block text-xs font-semibold text-muted"}>
        {label}
      </label>
      <select
        id={fid}
        className={cx(
          hideLabel ? "min-h-[36px]" : "mt-1 min-h-[44px]",
          "w-full rounded-lg border border-line bg-bg px-3 text-sm text-text",
        )}
        {...rest}
      >
        {options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      {hint ? <p className="mt-1 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-md bg-raised", className)} />;
}

export function Meter({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  limit: number;
  unit?: string;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const tone = limit === 0 ? "bg-faint" : pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-ok";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-muted">{label}</span>
        <span className="tabular text-text">
          {limit === 0 ? "Not in plan" : `${used} / ${limit}${unit ? ` ${unit}` : ""}`}
        </span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
      >
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cx("font-mono", className)}>{children}</span>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-extrabold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
