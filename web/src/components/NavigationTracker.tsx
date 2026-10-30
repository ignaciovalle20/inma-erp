"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const CURRENT = "inma:nav-current";
const PREVIOUS = "inma:nav-previous";

/** Storage can be unavailable (private windows, blocked site data): then there is simply no history. */
function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The screen before this one in this tab, for "Volver" (lib/backNavigation.ts). Null when there is none. */
export function previousScreen(): string | null {
  return read(PREVIOUS);
}

/**
 * Remembers the screen before the current one, per tab. sessionStorage rather
 * than memory, so a reload of the page does not forget it.
 */
export function NavigationTracker() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    const url = search ? `${pathname}?${search}` : pathname;
    const current = read(CURRENT);
    if (current === url) return;
    try {
      if (current) sessionStorage.setItem(PREVIOUS, current);
      sessionStorage.setItem(CURRENT, url);
    } catch {
      // No history, then: "Volver" follows its link.
    }
  }, [pathname, search]);

  return null;
}
