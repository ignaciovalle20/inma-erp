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
              { label: "Servicios recurrentes", href: `${base}/recurring-services` },
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
    <aside className="flex h-full w-[252px] flex-none flex-col border-r border-[var(--color-sidebar-border)] bg-[var(--color-sidebar)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-sidebar-border)] px-[18px] py-5">
        <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] bg-[var(--color-accent)] text-[11px] font-bold text-[var(--color-on-accent)]">
          I
        </span>
        <span className="font-mono text-[11px] tracking-[0.16em] text-[var(--color-sidebar-mono)]">
          INMA ERP
        </span>
      </div>

      <div className="relative px-2.5 pt-3.5">
        <button
          type="button"
          onClick={() => setSwitcherOpen((open) => !open)}
          className="flex w-full items-center justify-between rounded-lg border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-panel)] px-3 py-2.5 text-left hover:bg-[var(--color-sidebar-hover)]"
        >
          <span className="flex min-w-0 flex-col">
            <span className="font-mono text-[9px] tracking-[0.18em] text-[var(--color-sidebar-mono)]">
              EMPRESA
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
          <div className="absolute left-2.5 right-2.5 top-full z-10 mt-1 rounded-lg border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-panel)] py-1 shadow-lg">
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

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-2.5 py-4">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 font-mono text-[9.5px] tracking-[0.16em] text-[var(--color-sidebar-mono-2)]">
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
                  className={`flex items-center gap-2 rounded-md px-2.5 py-[7px] text-[13.5px] no-underline ${
                    active
                      ? "bg-[var(--color-sidebar-active-bg)] font-semibold text-[var(--color-sidebar-active-text)]"
                      : "text-[var(--color-sidebar-text-2)] hover:bg-[var(--color-sidebar-hover)]"
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

      <div className="border-t border-[var(--color-sidebar-border)] px-2.5 py-2">
        <Link
          href="/settings/ai"
          className={`flex items-center gap-2 rounded-md px-2.5 py-[7px] text-[13.5px] no-underline ${
            pathname === "/settings/ai"
              ? "bg-[var(--color-sidebar-active-bg)] font-semibold text-[var(--color-sidebar-active-text)]"
              : "text-[var(--color-sidebar-text-2)] hover:bg-[var(--color-sidebar-hover)]"
          }`}
        >
          Asistente IA
        </Link>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--color-sidebar-border)] px-[14px] py-3">
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
