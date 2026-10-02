import Link from "next/link";

const TABS = [
  { key: "month", label: "Mes a mes", path: "" },
  { key: "debt", label: "Deuda", path: "/debt" },
  { key: "services", label: "Servicios", path: "/services" },
  { key: "cost-pools", label: "Pools de costo", path: "/cost-pools" },
] as const;

export type RecurringServicesTab = (typeof TABS)[number]["key"];

/** The module's sections: the month board (Planner replacement), Deuda, the service catalog and cost pools. */
export function RecurringServicesNav({
  companyId,
  active,
  debtCount,
}: {
  companyId: string;
  active: RecurringServicesTab;
  debtCount?: number;
}) {
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-[var(--color-hairline)] px-1">
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={`/companies/${companyId}/recurring-services${tab.path}`}
            aria-current={isActive ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] no-underline ${
              isActive
                ? "border-[var(--color-ink)] font-semibold text-[var(--color-ink)]"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {tab.label}
            {tab.key === "debt" && debtCount ? (
              <span className="ml-1.5 font-mono text-[11px] text-[var(--color-muted)]">{debtCount}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
