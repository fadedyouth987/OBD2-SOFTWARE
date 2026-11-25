"use client";

import { useCallback, useEffect, useState } from "react";

export const THEME_KEY = "rootcause.theme";

/** Runs before paint (see app/layout.tsx) so Daylight mode doesn't flash. */
export const THEME_BOOT_SCRIPT = `try{if(localStorage.getItem("${THEME_KEY}")==="daylight")document.documentElement.classList.add("daylight")}catch(e){}`;

export function useTheme(): { daylight: boolean; toggle: () => void } {
  const [daylight, setDaylight] = useState(false);
  useEffect(() => setDaylight(document.documentElement.classList.contains("daylight")), []);
  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains("daylight");
    document.documentElement.classList.toggle("daylight", next);
    try {
      window.localStorage.setItem(THEME_KEY, next ? "daylight" : "night");
    } catch {
      /* ignore */
    }
    setDaylight(next);
  }, []);
  return { daylight, toggle };
}
