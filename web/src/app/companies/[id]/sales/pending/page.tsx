import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getSalesPending,
  getProjectBillingBalances,
  type PendingSalesRow,
  type SalesPending,
} from "@/lib/dal";
import type { JobBalance } from "@/lib/nubox";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { formatAmount, formatDisplayDate, paymentStatusLabel, paymentStatusVariant } from "@/lib/paymentStatus";
import { LinkInvoiceForm, MarkPaidForm, PairCreditNoteForm } from "./forms";

function Section({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-[var(--color-ink)]">
          {title}
          <Badge variant={count > 0 ? "warning" : "positive"}>{count}</Badge>
        </h2>
        <p className="text-[12px] text-[var(--color-muted)]">{hint}</p>
      </div>
      {count === 0 ? (
        <p className="rounded-[10px] border border-dashed border-[var(--color-hairline)] p-3 text-center text-[12.5px] text-[var(--color-muted)]">
          Nada pendiente.
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function documentLabel(row: PendingSalesRow): string {
  const prefix = row.documentType === "credit_note" ? "N/C" : row.documentType === "invoice" ? "FAC" : "Manual";
  return row.documentNumber ? `${prefix} ${row.documentNumber}` : prefix;
}

export default async function SalesPendingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  let pending: SalesPending | null = null;
  let jobs: JobBalance[] = [];
  let error: string | null = null;

  try {
    [pending, jobs] = await Promise.all([getSalesPending(id), getProjectBillingBalances(id)]);
  } catch (thrown) {
    console.error(thrown);
    error = thrown instanceof Error ? thrown.message : "No se pudieron leer los pendientes.";
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Pendientes de ventas"
        subtitle={membership.company.name}
        actions={
          <Link
            href={`/companies/${id}/sales`}
            className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            Volver a ventas
          </Link>
        }
      />

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-3 py-2.5 text-[13px] text-[var(--color-negative-ink)]"
        >
          {error}
        </div>
      ) : null}

      {pending ? (
        <>
          <Section
            title="Notas de crédito sin emparejar"
            hint="Cada N/C anula la factura que corrige (mismo cliente y neto). Al emparejar, ambas salen de las ventas y los reportes."
            count={pending.unpairedCreditNotes.length}
          >
            <TableCard>
              <thead>
                <tr>
                  <Th>N/C</Th>
                  <Th>Cliente</Th>
                  <Th>Fecha</Th>
                  <Th align="right">Neto</Th>
                  <Th>Factura que anula</Th>
                </tr>
              </thead>
              <tbody>
                {pending.unpairedCreditNotes.map((note) => (
                  <Tr key={note.id}>
                    <Td className="font-mono">{documentLabel(note)}</Td>
                    <Td>{note.clientName ?? "—"}</Td>
                    <Td className="font-mono">{formatDisplayDate(note.documentDate)}</Td>
                    <Td align="right" className="font-mono">
                      {formatAmount(note.netAmount)}
                    </Td>
                    <Td>
                      <PairCreditNoteForm companyId={id} creditNoteId={note.id} candidates={note.candidates} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableCard>
          </Section>

          <Section
            title="Facturas sin vincular a un trabajo"
            hint={`Se vinculan por el saldo por facturar del trabajo del cliente. El área de la factura se toma del trabajo. Solo se listan las de los últimos 120 días${
              pending.olderUnlinkedInvoices > 0
                ? `; hay ${pending.olderUnlinkedInvoices} facturas anteriores sin trabajo (historial anterior al ERP), que no se listan acá`
                : ""
            }.`}
            count={pending.unlinkedInvoices.length}
          >
            <TableCard>
              <thead>
                <tr>
                  <Th>Factura</Th>
                  <Th>Cliente</Th>
                  <Th>Fecha</Th>
                  <Th align="right">Neto</Th>
                  <Th>Trabajo</Th>
                </tr>
              </thead>
              <tbody>
                {pending.unlinkedInvoices.map((invoice) => (
                  <Tr key={invoice.id}>
                    <Td className="font-mono">{documentLabel(invoice)}</Td>
                    <Td>{invoice.clientName ?? "—"}</Td>
                    <Td className="font-mono">{formatDisplayDate(invoice.documentDate)}</Td>
                    <Td align="right" className="font-mono">
                      {formatAmount(invoice.netAmount)}
                    </Td>
                    <Td>
                      <LinkInvoiceForm
                        companyId={id}
                        salesDocumentId={invoice.id}
                        clientId={invoice.clientId}
                        netAmount={invoice.netAmount}
                        jobs={jobs}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableCard>
          </Section>

          <Section
            title="Revisar cobro en Nubox"
            hint={
              pending.staleReferenceDate
                ? `Facturas por vencer o vencidas anteriores al ${formatDisplayDate(pending.staleReferenceDate)} (la más antigua del último archivo): Nubox ya no las actualiza. Revisá el cobro allá y marcá las pagadas.`
                : "Todavía no hay un archivo de Nubox importado."
            }
            count={pending.staleUnpaidInvoices.length}
          >
            <TableCard>
              <thead>
                <tr>
                  <Th>Factura</Th>
                  <Th>Cliente</Th>
                  <Th>Fecha</Th>
                  <Th align="right">Total</Th>
                  <Th>Cobro</Th>
                  <Th>Marcar como pagada</Th>
                </tr>
              </thead>
              <tbody>
                {pending.staleUnpaidInvoices.map((invoice) => (
                  <Tr key={invoice.id}>
                    <Td className="font-mono">{documentLabel(invoice)}</Td>
                    <Td>{invoice.clientName ?? "—"}</Td>
                    <Td className="font-mono">{formatDisplayDate(invoice.documentDate)}</Td>
                    <Td align="right" className="font-mono">
                      {formatAmount(invoice.totalAmount)}
                    </Td>
                    <Td>
                      <Badge variant={paymentStatusVariant(invoice.paymentStatus)}>
                        {paymentStatusLabel(invoice.paymentStatus)}
                      </Badge>
                    </Td>
                    <Td>
                      <MarkPaidForm companyId={id} salesDocumentId={invoice.id} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableCard>
          </Section>

          <Section
            title="Ventas sin factura sin cobrar"
            hint="Ventas registradas desde un trabajo sin factura: el cobro se marca a mano, con fecha y medio de pago."
            count={pending.unpaidManualSales.length}
          >
            <TableCard>
              <thead>
                <tr>
                  <Th>Venta</Th>
                  <Th>Cliente</Th>
                  <Th>Fecha</Th>
                  <Th align="right">Total</Th>
                  <Th>Marcar como pagada</Th>
                </tr>
              </thead>
              <tbody>
                {pending.unpaidManualSales.map((sale) => (
                  <Tr key={sale.id}>
                    <Td className="font-mono">{documentLabel(sale)}</Td>
                    <Td>{sale.clientName ?? "—"}</Td>
                    <Td className="font-mono">{formatDisplayDate(sale.documentDate)}</Td>
                    <Td align="right" className="font-mono">
                      {formatAmount(sale.totalAmount)}
                    </Td>
                    <Td>
                      <MarkPaidForm companyId={id} salesDocumentId={sale.id} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableCard>
          </Section>
        </>
      ) : null}
    </div>
  );
}
