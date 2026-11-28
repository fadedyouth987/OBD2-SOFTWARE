// The web app's design tokens (apps/web/src/app/globals.css, "Night Cab" dark
// default; DESIGN.md A-DES-5), so the app's own screens match the web it shows.
// tests/tokens.test.ts fails if these drift from the CSS.

export const color = {
  bg: "#0c0f14",
  panel: "#151a22",
  raised: "#1d2430",
  line: "#2a3342",
  text: "#e6ebf2",
  muted: "#a7b2c3",
  faint: "#8a96a8",
  accent: "#e0242f",
  accentText: "#ffffff",
  blue: "#1a64d6",
  blueInk: "#7ab0ff",
  dangerInk: "#ff8080",
  accentInk: "#ff6b73",
  ok: "#10b981",
  warn: "#f59e0b",
  danger: "#ef4444",
  focus: "#7fb0ff",
} as const;

/** The CSS variable each token mirrors. */
export const CSS_VAR: Record<keyof typeof color, string> = {
  bg: "--bg",
  panel: "--panel",
  raised: "--raised",
  line: "--line",
  text: "--text",
  muted: "--muted",
  faint: "--faint",
  accent: "--accent",
  accentText: "--accent-text",
  blue: "--blue",
  blueInk: "--blue-ink",
  dangerInk: "--danger-ink",
  accentInk: "--accent-ink",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  focus: "--focus",
};

/** Web: rounded-xl cards, rounded-lg controls, 44 px minimum targets (A-DES-3). */
export const radius = { card: 12, control: 8, pill: 999 } as const;
export const MIN_TARGET = 44;
export const font = { sans: undefined, mono: "monospace" } as const;
