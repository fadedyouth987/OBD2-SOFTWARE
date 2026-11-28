"use client";

/**
 * A QR code drawn from the daemon's module matrix (rows of '1' dark, '0' light).
 * Pure data to SVG rectangles: nothing from the daemon is ever parsed as markup.
 * Always dark on white with a 4-module quiet zone, whatever the theme, so phone
 * cameras read it.
 */
export function QrCode({ rows, label, size = 232 }: { rows: string[]; label: string; size?: number }) {
  const n = rows.length;
  if (n === 0 || rows.some((r) => r.length !== n || /[^01]/.test(r))) return null;
  const quiet = 4;
  const total = n + quiet * 2;
  // One path for every dark module keeps the DOM small (a 57x57 code is ~1,600 modules).
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      if (row[x] !== "1") continue;
      let run = 1;
      while (x + run < n && row[x + run] === "1") run++;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className="rounded-lg"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
