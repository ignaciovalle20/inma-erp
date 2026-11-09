import Link from "next/link";
import { getMsLicensePoolMonths } from "@/lib/dal";
import { monthsToSplit } from "@/lib/msLicensePool";
import { Money } from "@/components/Money";

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

/**
 * Proposes the MS licenses split as soon as an Intcomex (Chile) or TGM
 * (Uruguay) invoice is registered or imported (fix-math 2026-11, point 2).
 * On the costs list: every month with such invoices and no split. On a cost
 * document: only its own month, when it is one of those invoices.
 */
export async function MsLicenseProposalBanner({
  companyId,
  document,
}: {
  companyId: string;
  /** The cost document being shown; omitted on the list. */
  document?: { supplierId: string | null; period: string };
}) {
  const { months } = await getMsLicensePoolMonths(companyId);
  const pending = monthsToSplit(months).filter(
    (month) => !document || (month.supplierId === document.supplierId && month.period === document.period),
  );
  if (pending.length === 0) return null;

  const href = (period: string) => `/companies/${companyId}/costs/ms-licenses/propose?period=${period.slice(0, 7)}`;

  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3 text-[12.5px]">
      <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">
        {document ? "Factura de licencias MS sin repartir" : "Facturas de licencias MS sin repartir"}
      </span>
      {pending.map((month) => (
        <span key={`${month.period}-${month.currency}`} className="text-[var(--color-warning-ink)]">
          {month.supplierName}, {formatPeriod(month.period)}: <Money value={month.netTotal} currency={month.currency} /> ·{" "}
          <Link href={href(month.period)} className="font-medium text-[var(--color-accent-strong)]">
            Ver el reparto propuesto
          </Link>
        </span>
      ))}
    </div>
  );
}
