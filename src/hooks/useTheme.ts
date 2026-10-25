"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Light/dark theme: follows the system until the visitor picks one, then remembers it. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const explicit = document.documentElement.dataset.theme;
    setTheme(explicit === "dark" || explicit === "light" ? explicit : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);

  const toggle = useCallback(() => {
    setTheme(current => {
      const next: Theme = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("aura-theme", next);
      } catch {
        // Storage may be blocked; the choice still applies to this visit.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
