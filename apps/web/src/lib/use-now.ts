"use client";

import { useEffect, useState } from "react";

/** Current time (ms), refreshed every `intervalMs`, so age checks update even when no new data arrives. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
