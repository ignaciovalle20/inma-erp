"use client";

import { useEffect, useState } from "react";

export type GuideTocItem = { id: string; label: string };

/**
 * Sticky in-page table of contents for the guide, with scroll-spy
 * active-section highlighting. Hidden below the `lg` breakpoint -- the
 * inline "En esta página" chip list at the top of the guide covers
 * navigation on narrower screens instead.
 */
export function GuideToc({ items }: { items: GuideTocItem[] }) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? "");

  useEffect(() => {
    const sections = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);

    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [items]);

  return (
    <nav className="sticky top-6 hidden max-h-[calc(100vh-48px)] w-[188px] flex-none flex-col gap-0.5 overflow-y-auto self-start lg:flex">
      <div className="mb-1.5 px-2.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted)]">
        En esta página
      </div>
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          className={`rounded-md px-2.5 py-[7px] text-[12.5px] leading-tight no-underline ${
            activeId === item.id
              ? "bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent-strong)]"
              : "text-[var(--color-ink-2)] hover:bg-[var(--color-row)]"
          }`}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
