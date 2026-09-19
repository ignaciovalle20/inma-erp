"use client";

import { useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { TopBar } from "@/components/TopBar";

const COLLAPSED_KEY = "inma-erp-sidebar-collapsed";
const COLLAPSED_EVENT = "inma-erp-sidebar-change";

// Fallback so the toggle still works when browser storage is blocked.
let collapsedInMemory = false;

function subscribeToCollapsed(onChange: () => void) {
  window.addEventListener(COLLAPSED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(COLLAPSED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return collapsedInMemory;
  }
}

function toggleCollapsed() {
  const next = !getCollapsed();
  collapsedInMemory = next;
  try {
    localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  } catch {
    // In-memory fallback above still applies for this session.
  }
  window.dispatchEvent(new Event(COLLAPSED_EVENT));
}

/**
 * Shared chrome for AppShell and the /companies/[id] layout. On md+ the
 * sidebar sits beside the content and the TopBar menu button hides/shows
 * it (choice remembered in localStorage); below md it is an off-canvas
 * drawer, closed by default, opened from the same button. The drawer is
 * open only for the pathname it was opened on, so navigating (tapping a
 * sidebar link) closes it without an effect.
 */
export function ShellFrame({
  sidebar,
  chat,
  children,
}: {
  sidebar: React.ReactNode;
  chat: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const open = openPath === pathname;
  const collapsed = useSyncExternalStore(subscribeToCollapsed, getCollapsed, () => false);

  function handleMenuClick() {
    if (window.matchMedia("(min-width: 768px)").matches) {
      toggleCollapsed();
    } else {
      setOpenPath(pathname);
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <div
        className={`fixed inset-y-0 left-0 z-40 flex transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        } ${collapsed ? "md:hidden" : ""}`}
      >
        {sidebar}
      </div>
      {open ? (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setOpenPath(null)}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      ) : null}
      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--color-canvas)]">
        <TopBar onMenuClick={handleMenuClick} />
        <div className="px-4 py-[18px] md:px-7 md:py-[22px]">{children}</div>
      </main>
      {chat}
    </div>
  );
}
