import { Money } from "@/components/Money";

export function Waterfall({
  currency,
  netSales,
  directCosts,
  directMargin,
  generalCosts,
  operatingResult,
}: {
  currency: string;
  netSales: number;
  directCosts: number;
  directMargin: number;
  generalCosts: number;
  operatingResult: number;
}) {
  const base = netSales !== 0 ? netSales : 1;
  const rows = [
    { label: "Ventas netas", value: netSales, bold: false },
    { label: "− Costos directos", value: directCosts, bold: false },
    { label: "Margen directo", value: directMargin, bold: true },
    { label: "− Costos generales", value: generalCosts, bold: false },
    { label: "Resultado operativo", value: operatingResult, bold: true, final: true },
  ];

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span
              className={`text-[13px] ${row.bold ? "font-semibold text-[var(--color-ink)]" : "text-[var(--color-ink-2)]"}`}
            >
              {row.label}
            </span>
            <Money
              value={row.value}
              currency={currency}
              className={`text-[13px] ${
                row.final
                  ? "font-semibold text-[var(--color-accent-strong)]"
                  : row.bold
                    ? "font-semibold text-[var(--color-ink)]"
                    : "text-[var(--color-ink)]"
              }`}
            />
          </div>
          <div className="h-1.5 w-full rounded-full bg-[#f1f1ed]">
            <div
              className="h-1.5 rounded-full bg-[var(--color-accent-bright)]"
              style={{
                width: `${Math.max(0, Math.min(100, (Math.abs(row.value) / Math.abs(base)) * 100))}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
