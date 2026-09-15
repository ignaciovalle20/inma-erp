"use client";

import { useSyncExternalStore } from "react";
import { getTheme, getServerTheme, setTheme, subscribeToTheme } from "@/lib/theme";

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, getServerTheme);

  return (
    <div role="group" aria-label="Tema de apariencia" className="theme-toggle">
      <button type="button" data-theme-option="light" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </svg>
        Claro
      </button>
      <button type="button" data-theme-option="dark" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
          <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
        </svg>
        Oscuro
      </button>
    </div>
  );
}
