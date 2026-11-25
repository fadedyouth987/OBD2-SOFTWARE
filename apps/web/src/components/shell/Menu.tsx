"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cx } from "@/components/ui";

/** Disclosure menu: button + popover, Escape / outside click close, focus returns. */
export function Menu({
  label,
  button,
  children,
  align = "right",
  buttonClassName,
}: {
  label: string;
  button: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    const first = root.current?.querySelector<HTMLElement>("[data-menu-item]");
    first?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={btn}
        type="button"
        aria-label={label || undefined}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-line bg-raised px-2.5 text-xs font-semibold hover:border-muted",
          buttonClassName,
        )}
      >
        {button}
      </button>
      {open ? (
        <div
          id={id}
          className={cx(
            "absolute z-40 mt-1 min-w-[240px] rounded-lg border border-line bg-panel p-1.5 shadow-2xl",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  onSelect,
  children,
  disabled,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-menu-item
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-[40px] w-full items-center gap-2 rounded-md px-2.5 text-left text-sm hover:bg-raised disabled:opacity-50"
    >
      {children}
    </button>
  );
}
