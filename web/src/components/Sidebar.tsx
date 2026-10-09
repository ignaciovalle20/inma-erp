"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/logout/actions";

type NavItem = { label: string; href: string; badge?: number };
type NavGroup = { label: string; items: NavItem[] };

export type SidebarCompany = {
  id: string;
  name: string;
  currency: string;
};

export function Sidebar({
  companyId,
  companyName,
  companyCurrency,
  companies,
  userEmail,
  role,
}: {
  companyId?: string;
  companyName?: string;
  companyCurrency?: string;
  companies: SidebarCompany[];
  userEmail: string;
  role?: string;
}) {
  const pathname = usePathname();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const base = companyId ? `/companies/${companyId}` : null;
  const groups: NavGroup[] = [
    ...(base
      ? [
          {
            label: "GESTIÓN",
            items: [
              { label: "Resumen", href: base },
              { label: "Ventas", href: `${base}/sales` },
              { label: "Costos", href: `${base}/costs` },
              { label: "Proyectos", href: `${base}/projects` },
              { label: "Servicios recurrentes", href: `${base}/recurring-services` },
            ],
          },
        ]
      : []),
    {
      label: "ANÁLISIS",
      items: [
        ...(base
          ? [
              { label: "Resultado mensual", href: `${base}/reports/monthly-result` },
              { label: "Rentabilidad", href: `${base}/reports/profitability` },
            ]
          : []),
        { label: "Consolidado USD", href: "/reports/consolidated" },
      ],
    },
    ...(base
      ? [
          {
            label: "CONFIGURACIÓN",
            items: [
              { label: "Clientes", href: `${base}/clients` },
              { label: "Proveedores", href: `${base}/suppliers` },
              { label: "Áreas de negocio", href: `${base}/areas` },
              { label: "Personal", href: `${base}/personnel` },
            ],
          },
          {
            label: "AYUDA",
            items: [{ label: "Guía de la app", href: `${base}/guide` }],
          },
        ]
      : []),
  ];

  return (
    <aside className="flex h-full max-h-dvh min-h-0 w-[252px] flex-none flex-col border-r border-[var(--color-sidebar-border)] bg-[var(--color-sidebar)]">
      <div className="flex flex-none items-center gap-2 border-b border-[var(--color-sidebar-border)] px-5 py-4">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-accent)] text-[11px] font-bold text-[var(--color-on-accent)]">
          I
        </span>
        <span className="text-small font-semibold tracking-[0.12em] text-[var(--color-sidebar-mono)]">
          INMA ERP
        </span>
      </div>

      <div className="relative flex-none px-3 pt-4">
        <button
          type="button"
          onClick={() => setSwitcherOpen((open) => !open)}
          className="flex w-full items-center justify-between rounded-control border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-panel)] px-3 py-2 text-left hover:bg-[var(--color-sidebar-hover)]"
        >
          <span className="flex min-w-0 flex-col">
            <span className="caps-label text-[var(--color-sidebar-mono)]">
              Empresa
            </span>
            <span className="truncate text-[13.5px] font-semibold text-[var(--color-sidebar-text)]">
              {companyName ?? "Elegir empresa"}
            </span>
          </span>
          <span className="ml-2 flex items-center gap-1.5">
            {companyCurrency ? (
              <span className="rounded border border-[var(--color-sidebar-border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-sidebar-text-2)]">
                {companyCurrency}
              </span>
            ) : null}
            <span className="text-[var(--color-sidebar-text-2)]">▾</span>
          </span>
        </button>
        {switcherOpen ? (
          <div className="absolute left-3 right-3 top-full z-10 mt-1 max-h-[60dvh] overflow-y-auto rounded-control border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-panel)] py-1 shadow-popover">
            {companies.map((company) => (
              <Link
                key={company.id}
                href={`/companies/${company.id}`}
                onClick={() => setSwitcherOpen(false)}
                className="block px-3 py-2 text-[13px] text-[var(--color-sidebar-text)] no-underline hover:bg-[var(--color-sidebar-hover)]"
              >
                {company.name}
              </Link>
            ))}
            <Link
              href="/companies"
              onClick={() => setSwitcherOpen(false)}
              className="block border-t border-[var(--color-sidebar-border)] px-3 py-2 text-[13px] text-[var(--color-sidebar-text-2)] no-underline hover:bg-[var(--color-sidebar-hover)]"
            >
              Gestionar empresas
            </Link>
          </div>
        ) : null}
      </div>

      {/* min-h-0 + overflow-y-auto: on a short window the menu scrolls on
          its own and the last item is never cut off by the footer. */}
      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 py-4">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="caps-label px-3 pb-1 text-[var(--color-sidebar-mono-2)]">
              {group.label}
            </div>
            {group.items.map((item) => {
              const active =
                item.href === base
                  ? pathname === base
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex min-h-9 items-center gap-2 rounded-md px-3 text-[13.5px] no-underline ${
                    active
                      ? "bg-[var(--color-sidebar-active-bg)] font-semibold text-[var(--color-sidebar-active-text)] before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-[var(--color-accent-bright)]"
                      : "text-[var(--color-sidebar-text-2)] hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-sidebar-text)]"
                  }`}
                >
                  <span
                    className="h-[5px] w-[5px] flex-none rounded-full"
                    style={{
                      backgroundColor: active
                        ? "var(--color-accent-bright)"
                        : "var(--color-sidebar-dot)",
                    }}
                  />
                  {item.label}
                  {item.badge ? (
                    <span className="ml-auto font-mono text-[10px] text-[var(--color-warning)]">
                      {item.badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex-none border-t border-[var(--color-sidebar-border)] px-3 py-2">
        <Link
          href="/settings/ai"
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={`flex min-h-9 items-center gap-2 rounded-md px-3 text-[13.5px] no-underline ${
            pathname.startsWith("/settings")
              ? "bg-[var(--color-sidebar-active-bg)] font-semibold text-[var(--color-sidebar-active-text)]"
              : "text-[var(--color-sidebar-text-2)] hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-sidebar-text)]"
          }`}
        >
          Configuración IA
        </Link>
      </div>

      <div className="flex flex-none items-center justify-between gap-2 border-t border-[var(--color-sidebar-border)] px-4 py-3">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12.5px] text-[var(--color-sidebar-text)]">
            {userEmail}
          </span>
          <span className="font-mono text-[10px] text-[var(--color-sidebar-mono-2)]">
            {role}
          </span>
        </span>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-[5px] border border-[var(--color-sidebar-border)] px-2.5 py-1 text-[12px] text-[var(--color-sidebar-text-2)] hover:bg-[var(--color-sidebar-hover)]"
          >
            Salir
          </button>
        </form>
      </div>
    </aside>
  );
}
