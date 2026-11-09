import Link from "next/link";
import { getMsLicenseInvoices } from "@/lib/dal";
import { suggestedInvoices, type MsLicenseInvoice } from "@/lib/msLicensePool";
import { Money } from "@/components/Money";

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

function proposeHref(companyId: string, documentId: string): string {
  return `/companies/${companyId}/costs/ms-licenses/propose?document=${documentId}`;
}

/** Why this invoice is the suggested one: its net against the expected cost. */
function suggestionReason(invoice: MsLicenseInvoice) {
  return invoice.referenceNet !== null ? (
    <>
      su neto es el más cercano a la factura de licencias anterior (
      <Money value={invoice.referenceNet} currency={invoice.currency} />)
    </>
  ) : (
    <>es la primera del mes sin asignar (todavía no hay una factura de licencias anterior marcada)</>
  );
}

/**
 * The MS licenses invoice, one per supplier and month (fix-ms-invoice 2026-11):
 * Intcomex (Chile) and TGM (Uruguay) also bill hardware and other general
 * costs, so only the licenses invoice is split among the MS clients.
 * On the costs list: the suggested licenses invoice of each month that has
 * none yet. On a cost document of that supplier: the warning only when it is
 * the suggested one (or a licenses invoice whose split is missing); any other
 * of its invoices only offers the button, in case it is the licenses one.
 */
export async function MsLicenseProposalBanner({
  companyId,
  documentId,
}: {
  companyId: string;
  /** The cost document being shown; omitted on the list. */
  documentId?: string;
}) {
  const { invoices } = await getMsLicenseInvoices(companyId);

  if (!documentId) {
    const suggested = suggestedInvoices(invoices);
    if (suggested.length === 0) return null;
    return (
      <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3 text-[12.5px]">
        <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">
          Facturas de licencias MS sin repartir
        </span>
        <span className="text-[var(--color-warning-ink)]">
          Sugerencia de la factura de licencias de cada mes (una por proveedor y mes). Revisá que sea la de licencias
          antes de repartirla; si no lo es, abrí la correcta y repartila desde su detalle.
        </span>
        {suggested.map((invoice) => (
          <span key={invoice.documentId} className="text-[var(--color-warning-ink)]">
            {formatPeriod(invoice.period)} · {invoice.supplierName}{" "}
            <Link href={`/companies/${companyId}/costs/${invoice.documentId}`} className="font-medium text-[var(--color-ink)]">
              {invoice.documentNumber ?? "sin número"}
            </Link>{" "}
            · <Money value={invoice.netAmount} currency={invoice.currency} /> ·{" "}
            <Link href={proposeHref(companyId, invoice.documentId)} className="font-medium text-[var(--color-accent-strong)]">
              Es la factura de licencias MS → repartir
            </Link>
          </span>
        ))}
      </div>
    );
  }

  const invoice = invoices.find((row) => row.documentId === documentId);
  if (!invoice) return null;

  if (invoice.poolId) {
    if (invoice.poolAllocated) return null; // the page shows "Cubierto por pool"
    return (
      <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3 text-[12.5px]">
        <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">Factura de licencias MS sin repartir</span>
        <Link href={`/companies/${companyId}/costs/ms-licenses/${invoice.poolId}`} className="font-medium text-[var(--color-accent-strong)]">
          Abrir su reparto
        </Link>
      </div>
    );
  }

  if (invoice.suggested) {
    return (
      <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3 text-[12.5px]">
        <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">Factura de licencias MS sin repartir</span>
        <span className="text-[var(--color-warning-ink)]">
          Sugerida como la factura de licencias de {invoice.supplierName} en {formatPeriod(invoice.period)}:{" "}
          {suggestionReason(invoice)}. Mientras no se reparte, cuenta como gasto general y los clientes de licencias
          quedan sin costo.
        </span>
        <Link href={proposeHref(companyId, invoice.documentId)} className="font-medium text-[var(--color-accent-strong)]">
          Es la factura de licencias MS → repartir
        </Link>
      </div>
    );
  }

  // Another invoice of the supplier: not assigned and positive, it may still be
  // the licenses one (the suggestion is only a guess).
  if (invoice.assigned || invoice.netAmount <= 0 || invoice.legacyPoolId) return null;
  return (
    <p className="text-[12.5px] text-[var(--color-muted)]">
      Factura de {invoice.supplierName}: queda como gasto general salvo que sea la de licencias MS de{" "}
      {formatPeriod(invoice.period)}.{" "}
      <Link href={proposeHref(companyId, invoice.documentId)} className="font-medium text-[var(--color-accent-strong)]">
        Es factura de licencias MS → repartir
      </Link>
    </p>
  );
}
