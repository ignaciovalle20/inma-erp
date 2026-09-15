"use client";

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useState } from "react";
import { TOPBAR_BREADCRUMB_SLOT_ID } from "@/components/TopBar";

// useLayoutEffect runs synchronously before paint, so the portal swaps
// in before the browser shows a frame -- avoids a one-frame flash of a
// missing/stale breadcrumb on every client-side navigation. It warns
// if used during SSR, so fall back to useEffect there (a no-op either
// way, since there's no DOM to query server-side).
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  // The eyebrow renders in the shared topbar (via a portal) instead of
  // here, so it reads as part of the app chrome rather than repeating
  // inside every page's own content. The portal target only exists
  // client-side, so this resolves after mount (imperceptible in
  // practice -- Next hydrates fast, and this is an authenticated app,
  // not something crawled without JS).
  const [slot, setSlot] = useState<Element | null>(null);
  useIsomorphicLayoutEffect(() => {
    setSlot(document.getElementById(TOPBAR_BREADCRUMB_SLOT_ID));
  }, []);

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      {eyebrow && slot ? createPortal(eyebrow, slot) : null}
      <div className="flex flex-col gap-1">
        <h1 className="text-[16px] font-semibold tracking-[-0.01em] text-[var(--color-ink)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
