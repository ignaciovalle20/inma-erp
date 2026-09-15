"use client";

import { useSyncExternalStore } from "react";
import { getTheme, getServerTheme, setTheme, subscribeToTheme } from "@/lib/theme";

// PageHeader (rendered deep inside each page, not here) portals its
// eyebrow/breadcrumb text into this element instead of rendering it
// inline -- that keeps each page's PageHeader call as the single
// source of truth for its breadcrumb (no separate pathname->label
// table to keep in sync) while the text visually lives in the topbar.
export const TOPBAR_BREADCRUMB_SLOT_ID = "topbar-breadcrumb-slot";

export function TopBar() {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, getServerTheme);
  const isDark = theme === "dark";

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--color-hairline)] bg-[var(--color-surface)] px-6 py-2.5">
      {/*
        flex-1 (not justify-between on the parent) so this always
        reserves the leading space and pushes the button to the right,
        whether it's empty (nothing to show, no visible difference) or
        has portaled text -- justify-between only pushes the button
        right when there are two flex children, so it briefly sat at
        the far left while this was empty before PageHeader's portal
        landed on mount.
      */}
      <div
        id={TOPBAR_BREADCRUMB_SLOT_ID}
        className="flex-1 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-[var(--color-muted)]"
      />
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
