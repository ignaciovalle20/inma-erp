"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { TopBar } from "@/components/TopBar";

/**
 * Shared chrome for AppShell and the /companies/[id] layout: on md+ the
 * sidebar sits beside the content as before; below md it becomes an
 * off-canvas drawer opened from the TopBar's menu button. The drawer is
 * open only for the pathname it was opened on, so navigating (tapping
 * a sidebar link) closes it without an effect.
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

  return (
    <div className="flex h-screen overflow-hidden">
      <div
        className={`fixed inset-y-0 left-0 z-40 flex transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
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
        <TopBar onMenuClick={() => setOpenPath(pathname)} />
        <div className="px-4 py-[18px] md:px-7 md:py-[22px]">{children}</div>
      </main>
      {chat}
    </div>
  );
}
