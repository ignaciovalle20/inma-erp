import Link from "next/link";
import { formatPeriod } from "@/lib/period";
import type { MsLicensePool } from "@/lib/msLicensePool";

/**
 * Warning shown by the cost forms while what is being entered would be
 * "cubierto por pool": the Microsoft licenses invoice of a month that already
 * has an MS licenses pool (point 5 of docs/verificacion-contable-2026-10-04.md).
 * Saving is still allowed -- the database marks the document and no report
 * adds it -- but the person sees why before saving.
 */
export function MsPoolCoverageWarning({
  companyId,
  pool,
  failed = false,
}: {
  companyId: string;
  /** The pool the document would fall under (see findCoveringPool), or null. */
  pool: MsLicensePool | null;
  /** The pools could not be read: say it could not be checked. */
  failed?: boolean;
}) {
  if (!pool) {
    return failed ? (
      <p className="text-[12px] text-[var(--color-muted)]" role="status">
        No se pudo verificar si este costo ya está en un reparto de licencias MS.
      </p>
    ) : null;
  }

  const month = formatPeriod(pool.period);
  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-3 py-2.5 text-[13px] text-[var(--color-warning-ink)]"
    >
      <p className="font-semibold">Ya está en el reparto de licencias MS de {month}</p>
      <p>
        Este costo parece la factura de licencias MS de {month}
        {pool.supplierName ? ` (${pool.supplierName})` : ""}, y ese mes ya tiene su reparto: el costo
        ya está ahí. Si lo guardás igual, queda marcado «Cubierto por pool» y no suma al resultado
        mensual, para no contarlo dos veces.
      </p>
      <Link
        href={`/companies/${companyId}/costs/ms-licenses/${pool.id}`}
        className="mt-1 inline-block font-medium text-[var(--color-warning-ink)] underline"
      >
        Ver el reparto de {month}
      </Link>
    </div>
  );
}
