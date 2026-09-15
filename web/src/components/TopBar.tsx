"use client";

import { useSyncExternalStore } from "react";
import { getTheme, getServerTheme, setTheme, subscribeToTheme } from "@/lib/theme";

export function TopBar() {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, getServerTheme);
  const isDark = theme === "dark";

  return (
    <div className="sticky top-0 z-10 flex items-center justify-end border-b border-[var(--color-hairline)] bg-[var(--color-surface)] px-6 py-2.5">
      <button
        type="button"
        onClick={() => setTheme(isDark ? "light" : "dark")}
        aria-label={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
        title={isDark ? "Tema claro" : "Tema oscuro"}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-hairline)] text-[var(--color-ink-2)] hover:bg-[var(--color-row)]"
      >
        {isDark ? (
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
          </svg>
        ) : (
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
          </svg>
        )}
      </button>
    </div>
  );
}
