import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { amountTolerance, getAllocationsForTarget, getPeriodDetail, periodLabel } from "@/lib/salesAllocations";
import { PageHeader } from "@/components/PageHeader";
import { Badge, type BadgeVariant } from "@/components/Badge";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { monthLabel } from "@/lib/period";
import { formatDisplayDate, paymentStatusLabel, paymentStatusVariant } from "@/lib/paymentStatus";
import { PERIOD_BILLING_STATUS_LABELS } from "@/lib/recurringServiceTypes";
import { AdoptReferenceButton, PaymentToggle, QuantityForm } from "./controls";

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending_invoice: "neutral",
  invoiced: "warning",
  paid: "positive",
  void: "outline",
};

const DOCUMENT_PREFIX: Record<string, string> = {
  invoice: "FAC",
  receipt: "REC",
  manual: "Manual",
};

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="caps-label text-[var(--color-muted)]">{label}</dt>
      <dd className="text-[13px] text-[var(--color-ink)]">{children}</dd>
    </div>
  );
}

/**
 * One period of a recurring service: expected vs. billed, its state, the
 * invoices allocated to it, the quantity (per-unit services) and the
 * manual payment state (clients without invoice).
 */
export default async function RecurringServicePeriodPage({
  params,
}: {
  params: Promise<{ id: string; periodId: string }>;
}) {
  const { id, periodId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [detail, allocations] = await Promise.all([
    getPeriodDetail(id, periodId),
    getAllocationsForTarget(id, { periodId }),
  ]);

  if (!detail) {
    redirect(`/companies/${id}/recurring-services/periods`);
  }

  const tolerance = amountTolerance(detail.currency);
  const billed = detail.confirmed_count > 0;
  const differs = billed && Math.abs(detail.difference) > tolerance;
  const paid = detail.billing_status === "paid";
  const viaInvoices = billed;
  // Manual payment: a client without invoice, a period marked by hand, or
  // (through its invoices) one already billed.
  const canTogglePayment =
    detail.billing_status !== "void" &&
    (viaInvoices || !detail.requires_invoice || detail.status === "invoiced" || detail.status === "collected");

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / SERVICIOS RECURRENTES / PERÍODO"
        title={`${detail.service_name} · ${periodLabel(detail.period, detail.periodicity)}`}
        subtitle={`${detail.client_name ?? "Cliente desconocido"} · vence en ${monthLabel(detail.board_month)}`}
        back={{ href: `/companies/${id}/recurring-services/periods`, label: "Períodos" }}
      />

      <Card>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Detail label="Estado">
            <Badge variant={STATUS_VARIANT[detail.billing_status] ?? "neutral"}>
              {PERIOD_BILLING_STATUS_LABELS[detail.billing_status] ?? detail.billing_status}
            </Badge>
          </Detail>
          <Detail label="Esperado">
            <span className="text-[var(--color-muted)]">
              <Money value={detail.expected_amount} currency={detail.currency} />
            </span>
            {!billed ? <span className="block text-[11px] text-[var(--color-faint)]">estimado</span> : null}
          </Detail>
          <Detail label="Facturado">
            <Money value={detail.billed_amount} currency={detail.currency} />
            {detail.suggested_amount > 0 ? (
              <span className="block text-[11px] text-[var(--color-warning-ink)]">
                + <Money value={detail.suggested_amount} currency={detail.currency} showCurrency={false} /> sugerido
              </span>
            ) : null}
          </Detail>
          <Detail label="Diferencia">
            {billed ? (
              <Money value={detail.difference} currency={detail.currency} showCurrency={false} />
            ) : (
              <span className="text-[var(--color-faint)]">—</span>
            )}
          </Detail>
          {detail.pricing_mode === "per_unit" ? (
            <Detail label="Precio unitario">
              {detail.unit_price === null ? "—" : <Money value={detail.unit_price} currency={detail.currency} />}
            </Detail>
          ) : null}
          <Detail label="Referencial del servicio">
            {detail.reference_amount === null ? (
              <span className="text-[var(--color-faint)]">Sin referencial</span>
            ) : (
              <Money value={detail.reference_amount} currency={detail.currency} />
            )}
          </Detail>
          <Detail label="Factura">{detail.requires_invoice ? "Requiere factura" : "Sin factura"}</Detail>
          {detail.note ? (
            <div className="col-span-2 md:col-span-4">
              <Detail label="Notas">
                <span className="whitespace-pre-line">{detail.note}</span>
              </Detail>
            </div>
          ) : null}
        </dl>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {detail.pricing_mode === "per_unit" && detail.billing_status !== "void" ? (
          <Card>
            <QuantityForm companyId={id} periodId={periodId} quantity={detail.quantity} />
          </Card>
        ) : null}
        {canTogglePayment ? (
          <Card>
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] text-[var(--color-ink-2)]">
                {viaInvoices
                  ? "El pago sale del estado de las facturas asignadas."
                  : detail.requires_invoice
                    ? "Marcado a mano, sin factura asignada."
                    : "Cliente sin factura: el pago se marca a mano."}
              </p>
              <PaymentToggle companyId={id} periodId={periodId} paid={paid} viaInvoices={viaInvoices} />
            </div>
          </Card>
        ) : null}
        {differs ? (
          <Card>
            <div className="flex flex-col gap-2">
              <p className="text-[12.5px] text-[var(--color-ink-2)]">
                Se facturó <Money value={detail.billed_amount} currency={detail.currency} showCurrency={false} /> y se
                esperaba <Money value={detail.expected_amount} currency={detail.currency} showCurrency={false} />.
              </p>
              <AdoptReferenceButton companyId={id} periodId={periodId} />
            </div>
          </Card>
        ) : null}
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
            Facturas asignadas <span className="font-normal">· {allocations.length}</span>
          </h2>
          {detail.requires_invoice && detail.billing_status !== "void" ? (
            <Link
              href={`/companies/${id}/sales/reconcile?period=${detail.board_month}`}
              className="text-[12.5px] text-[var(--color-accent-strong)]"
            >
              Buscar la factura en pendientes de conciliar
            </Link>
          ) : null}
        </div>
        {allocations.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-[var(--color-hairline)] p-4 text-[12.5px] text-[var(--color-muted)]">
            Ninguna factura asignada todavía. Se asigna desde la factura (Ventas → Asignar).
          </p>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Documento</Th>
                <Th>Fecha</Th>
                <Th align="right">Asignado</Th>
                <Th align="right">Neto factura</Th>
                <Th>Pago</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {allocations.map((allocation) => (
                <Tr key={allocation.id}>
                  <Td className="whitespace-nowrap font-mono text-[12.5px]">
                    {DOCUMENT_PREFIX[allocation.document_type] ?? allocation.document_type}
                    {allocation.document_number ? ` ${allocation.document_number}` : ""}
                    {allocation.status === "suggested" ? (
                      <span className="ml-1.5">
                        <Badge variant="warning">Sugerida</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[12.5px] text-[var(--color-ink-2)]">
                    {allocation.document_date ? formatDisplayDate(allocation.document_date) : "—"}
                  </Td>
                  <Td align="right">
                    <Money value={allocation.amount} currency={allocation.currency || detail.currency} showCurrency={false} />
                  </Td>
                  <Td align="right" className="text-[var(--color-muted)]">
                    <Money value={allocation.net_amount} currency={allocation.currency || detail.currency} />
                  </Td>
                  <Td>
                    <Badge variant={paymentStatusVariant(allocation.payment_status)}>
                      {paymentStatusLabel(allocation.payment_status)}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/companies/${id}/sales/${allocation.sales_document_id}/allocations`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      {allocation.status === "suggested" ? "Revisar" : "Editar"}
                    </Link>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>
    </div>
  );
}
