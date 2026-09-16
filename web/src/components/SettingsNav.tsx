"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { label: "Asistente IA", href: "/settings/ai" },
  { label: "Acceso MCP", href: "/settings/mcp" },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex w-[180px] flex-none flex-col gap-0.5">
      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`rounded-md px-3 py-[7px] text-[13.5px] no-underline ${
            pathname === item.href
              ? "bg-[var(--color-row)] font-semibold text-[var(--color-ink)]"
              : "text-[var(--color-ink-2)] hover:bg-[var(--color-row)]"
          }`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
