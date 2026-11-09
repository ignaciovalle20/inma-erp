import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getMsLicenseInvoiceProposal } from "@/lib/dal";
import { licenseInvoiceBlocker } from "@/lib/msLicensePool";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { ConfirmProposalButton } from "./confirm-button";

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Es factura de licencias MS -> repartir" (fix-ms-invoice 2026-11): the split
 * of ONE Intcomex / TGM invoice before it is saved. Its net (only its own,
 * never the supplier's other invoices of the month) goes to the clients of the
 * pooled MS services in proportion to what was sold to each that month
 * (billed, else expected); the parts add up exactly to the net.
 * "Confirmar reparto" saves this same split.
 */
export default async function MsLicenseProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ document?: string }>;
}) {
  const { id } = await params;
  const { document: documentParam } = await searchParams;
  const user = await getSession();
  if (!user) redirect("/login");

  const membership = await getCompanyForEdit(id);
  if (!membership) redirect("/companies");

  const listHref = `/companies/${id}/costs/ms-licenses`;
  if (!documentParam || !UUID.test(documentParam)) redirect(listHref);
  const documentHref = `/companies/${id}/costs/${documentParam}`;

  const proposal = await getMsLicenseInvoiceProposal(id, documentParam);
  const invoice = proposal.invoice;
  const total = proposal.shares.reduce((sum, row) => sum + row.share, 0);
  const blocker = invoice ? licenseInvoiceBlocker(invoice) : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / REPARTO LICENCIAS MS"
        title={invoice ? `Reparto de la factura ${invoice.documentNumber ?? ""} -- ${formatPeriod(invoice.period)}` : "Reparto de licencias MS"}
        subtitle={membership.company.name}
        back={{ href: documentHref, label: "Documento de costo" }}
      />

      {proposal.error ? (
        <p role="alert" className="text-[13px] text-[var(--color-negative-ink)]">
          {proposal.error}
        </p>
      ) : null}

      {!invoice ? (
        <Card>
          <p className="text-[13px] text-[var(--color-muted)]">
            Este documento no es de Intcomex (Chile) ni de TGM (Uruguay), o es anterior a enero 2026: no se reparte como
            licencias MS.
          </p>
        </Card>
      ) : invoice.poolId ? (
        <Card>
          <p className="text-[13px] text-[var(--color-ink-2)]">
            Esta factura ya tiene su reparto de licencias.{" "}
            <Link href={`${listHref}/${invoice.poolId}`} className="font-medium text-[var(--color-accent-strong)]">
              Abrirlo
            </Link>{" "}
            (desde ahí se puede volver a repartir o deshacer).
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <div className="grid grid-cols-2 gap-4 text-[13px] sm:grid-cols-4">
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Factura</span>
                <Link href={documentHref} className="text-[var(--color-accent-strong)]">
                  {invoice.supplierName} {invoice.documentNumber ?? "sin número"} · {invoice.documentDate}
                </Link>
              </div>
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Neto a repartir (sin IVA)</span>
                <Money value={invoice.netAmount} currency={invoice.currency} />
              </div>
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Factura de licencias anterior</span>
                {invoice.referenceNet !== null ? (
                  <Money value={invoice.referenceNet} currency={invoice.currency} />
                ) : (
                  <span className="text-[var(--color-muted)]">Ninguna marcada</span>
                )}
              </div>
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Se reconoce en</span>
                <span>{formatPeriod(invoice.period)}, el mes de la factura</span>
              </div>
            </div>
            <p className="mt-3 text-[12px] text-[var(--color-muted)]">
              Solo se reparte el neto de esta factura. Las demás facturas del proveedor siguen como gasto general o en
              su trabajo, como cualquier costo.
            </p>
          </Card>

          {proposal.otherInvoices.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] px-4 py-3 text-[12.5px]">
              <span className="text-[13px] font-semibold text-[var(--color-warning-ink-2)]">
                {invoice.supplierName} ya tiene una factura de licencias repartida en {formatPeriod(invoice.period)}
              </span>
              {proposal.otherInvoices.map((other) => (
                <span key={other.documentId} className="text-[var(--color-warning-ink)]">
                  Factura {other.documentNumber ?? "sin número"} ({other.documentDate}):{" "}
                  <Money value={other.netAmount} currency={other.currency} /> ·{" "}
                  {other.poolId ? (
                    <Link href={`${listHref}/${other.poolId}`} className="font-medium text-[var(--color-accent-strong)]">
                      Ver su reparto
                    </Link>
                  ) : null}
                </span>
              ))}
              <span className="text-[var(--color-warning-ink)]">
                Hay una sola factura de licencias por mes. Si esta también lo es (por ejemplo, una refacturación),
                confirmalo abajo; si no, volvé atrás y dejala como gasto general o asignala a su trabajo.
              </span>
            </div>
          ) : null}

          {blocker ? (
            <p role="alert" className="text-[13px] text-[var(--color-negative-ink)]">
              {blocker}
            </p>
          ) : null}

          {proposal.unpooledServices.length > 0 ? (
            <p className="text-[12.5px] text-[var(--color-warning-ink)]">
              No entran en el reparto porque no usan el pool de licencias: {proposal.unpooledServices.join(", ")}.
              Si su costo es esta factura, activá &quot;Usa pool de costo compartido&quot; en cada servicio (Servicios
              recurrentes → editar) antes de confirmar.
            </p>
          ) : null}

          {blocker ? null : proposal.shares.length === 0 ? (
            <Card>
              <p className="text-[13px] text-[var(--color-muted)]">
                Ningún servicio de licencias MS que use el pool tiene ciclo en {formatPeriod(invoice.period)}, en{" "}
                {invoice.currency}: no hay entre quiénes repartir.
              </p>
            </Card>
          ) : (
            <>
              <TableCard>
                <thead>
                  <tr>
                    <Th>Cliente</Th>
                    <Th>Servicio</Th>
                    <Th align="right">Vendido en el mes</Th>
                    <Th align="right">Costo que le toca</Th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.shares.map((row) => (
                    <Tr key={row.occurrenceId}>
                      <Td className="font-medium text-[var(--color-ink)]">{row.clientName ?? "—"}</Td>
                      <Td className="text-[var(--color-ink-2)]">{row.serviceName}</Td>
                      <Td align="right">
                        <Money value={row.weight} currency={invoice.currency} showCurrency={false} />
                        {row.basis === "expected" ? (
                          <span className="block text-[11px] text-[var(--color-faint)]">esperado, sin facturar</span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <Money value={row.share} currency={invoice.currency} showCurrency={false} />
                      </Td>
                    </Tr>
                  ))}
                  <Tr className="hover:bg-transparent">
                    <Td className="font-semibold text-[var(--color-ink)]" colSpan={3}>
                      Total (el neto de la factura)
                    </Td>
                    <Td align="right" className="font-semibold text-[var(--color-ink)]">
                      <Money value={total} currency={invoice.currency} showCurrency={false} />
                    </Td>
                  </Tr>
                </tbody>
              </TableCard>
              <ConfirmProposalButton
                companyId={id}
                costDocumentId={invoice.documentId}
                secondInvoice={proposal.otherInvoices.length > 0}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
