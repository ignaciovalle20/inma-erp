import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { amountTolerance, getReconciliationQueue } from "@/lib/salesAllocations";
import { PageHeader } from "@/components/PageHeader";
import { PeriodPicker } from "@/components/PeriodPicker";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { currentMonth, formatPeriod, isValidMonth, monthLabel } from "@/lib/period";
import { getPendingCostSuggestions } from "@/lib/costServiceAllocations";
import { formatDisplayDate, paymentStatusLabel, paymentStatusVariant } from "@/lib/paymentStatus";
import { SUGGESTION_REASON_LABELS } from "@/lib/allocationSuggestions";
import { ConfirmSuggestedButton, CostSuggestionButtons, SuggestAllButton, TechnicianSuggestionButtons } from "./controls";
import { companyConfig } from "@/lib/companyConfig";
import { getPendingTechnicianSuggestions, type PendingTechnicianSuggestion } from "@/lib/technicianDal";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";

const DOCUMENT_PREFIX: Record<string, string> = {
  invoice: "FAC",
  receipt: "REC",
  manual: "Manual",
};

/**
 * Pendientes de conciliar (monthly close): the documents with an
 * unallocated balance, or with suggested allocations nobody confirmed
 * yet. ?period=YYYY-MM filters by document date; ?period=all shows every
 * month.
 */
export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const allMonths = sp.period === "all";
  const month = isValidMonth(sp.period) ? sp.period : currentMonth(membership.company.country);
  const basePath = `/companies/${id}/sales/reconcile`;
  const backedCompany = companyConfig(membership.company).country === "CL";
  const [{ rows, failed }, costSuggestions, technicianRead] = await Promise.all([
    getReconciliationQueue(id, allMonths ? null : month),
    getPendingCostSuggestions(id, allMonths ? null : month),
    backedCompany
      ? getPendingTechnicianSuggestions(id, allMonths ? null : month).then(
          (value) => ({ value, failed: false }),
          (error: unknown) => {
            console.error(error);
            return { value: [] as PendingTechnicianSuggestion[], failed: true };
          },
        )
      : Promise.resolve({ value: [] as PendingTechnicianSuggestion[], failed: false }),
  ]);
  const technicianSuggestions = technicianRead.value;
  const confirmableTechnician = technicianSuggestions.filter((row) => row.stillValid);

  const withSuggestions = rows.filter((row) => row.suggested_count > 0);
  // Suggestions that leave nothing unallocated can be confirmed in one go.
  const readyToConfirm = withSuggestions.filter(
    (row) => Math.abs(row.unallocated_amount) <= amountTolerance(row.currency),
  );

  const totals = new Map<string, { unallocated: number; count: number }>();
  for (const row of rows) {
    const entry = totals.get(row.currency) ?? { unallocated: 0, count: 0 };
    entry.unallocated += row.unallocated_amount;
    entry.count += 1;
    totals.set(row.currency, entry);
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS / CONCILIACIÓN"
        title="Pendientes de conciliar"
        subtitle={`${membership.company.name} · facturas con saldo sin asignar o asignaciones sugeridas sin confirmar`}
        back={{ href: `/companies/${id}/sales`, label: "Ventas" }}
        actions={<SuggestAllButton companyId={id} month={allMonths ? null : month} />}
      />

      <div className="flex flex-wrap items-center gap-3">
        {allMonths ? (
          <span className="text-[12.5px] font-medium text-[var(--color-ink)]">Todos los meses</span>
        ) : (
          <PeriodPicker period={month} basePath={basePath} />
        )}
        <Link
          href={allMonths ? basePath : `${basePath}?period=all`}
          className="text-[12.5px] text-[var(--color-accent-strong)]"
        >
          {allMonths ? "Ver por mes" : "Ver todos los meses"}
        </Link>
        {readyToConfirm.length > 1 ? (
          <ConfirmSuggestedButton
            companyId={id}
            salesDocumentIds={readyToConfirm.map((row) => row.sales_document_id)}
            label={`Confirmar las ${readyToConfirm.length} sugerencias completas`}
          />
        ) : null}
      </div>

      {failed ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          No se pudo leer la lista completa; puede faltar algún documento. Recargá la página.
        </p>
      ) : null}

      {totals.size > 0 ? (
        <div className="flex flex-wrap gap-2">
          {[...totals.entries()].map(([currency, entry]) => (
            <div
              key={currency}
              className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-2 text-[12.5px]"
            >
              <span className="caps-label text-[var(--color-muted)]">
                {allMonths ? "Total" : monthLabel(month)} · {currency}
              </span>
              <p>
                {entry.count} {entry.count === 1 ? "documento" : "documentos"} · sin asignar{" "}
                <Money value={entry.unallocated} currency={currency} showCurrency={false} />
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)]">
          <EmptyState
            message={
              allMonths
                ? "Todas las facturas están asignadas y confirmadas."
                : `Todas las facturas de ${monthLabel(month)} están asignadas y confirmadas.`
            }
          />
        </div>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Fecha</Th>
              <Th>Documento</Th>
              <Th>Cliente</Th>
              <Th align="right">Neto</Th>
              <Th align="right">Asignado</Th>
              <Th align="right">Sin asignar</Th>
              <Th>Pago</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tolerance = amountTolerance(row.currency);
              const over = row.unallocated_amount < -tolerance;
              return (
                <Tr key={row.sales_document_id}>
                  <Td className="whitespace-nowrap font-mono text-[12.5px] text-[var(--color-ink-2)]">
                    {formatDisplayDate(row.document_date)}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[12.5px]">
                    {DOCUMENT_PREFIX[row.document_type] ?? row.document_type}
                    {row.document_number ? ` ${row.document_number}` : ""}
                  </Td>
                  <Td>
                    <span className="font-medium text-[var(--color-ink)]">
                      {row.client_name ?? "Cliente desconocido"}
                    </span>
                    {row.suggested_count > 0 ? (
                      <span className="ml-1.5">
                        <Badge variant="warning">
                          {row.suggested_count} sugerida{row.suggested_count === 1 ? "" : "s"}
                        </Badge>
                      </span>
                    ) : null}
                    {row.suggestion && row.suggestion.reasons.length > 0 ? (
                      <span className="block text-[11.5px] text-[var(--color-warning-ink)]">
                        {row.suggestion.reasons.map((reason) => SUGGESTION_REASON_LABELS[reason]).join(" · ")}
                        {row.suggestion.difference !== null &&
                        Math.abs(row.suggestion.difference) > amountTolerance(row.currency) ? (
                          <>
                            {" · difiere del esperado en "}
                            {row.suggestion.difference > 0 ? "+" : ""}
                            <Money
                              value={row.suggestion.difference}
                              currency={row.currency}
                              showCurrency={false}
                              negativeClassName=""
                            />
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <Money value={row.net_amount} currency={row.currency} />
                  </Td>
                  <Td align="right" className="text-[var(--color-ink-2)]">
                    <Money value={row.confirmed_amount} currency={row.currency} showCurrency={false} />
                    {row.suggested_amount > 0 ? (
                      <span className="block text-[11px] text-[var(--color-warning-ink)]">
                        + <Money value={row.suggested_amount} currency={row.currency} showCurrency={false} /> sugerido
                      </span>
                    ) : null}
                  </Td>
                  <Td
                    align="right"
                    className={
                      over
                        ? "text-[var(--color-negative-ink)]"
                        : row.unallocated_amount > tolerance
                          ? "font-medium text-[var(--color-warning-ink)]"
                          : "text-[var(--color-muted)]"
                    }
                  >
                    <Money value={row.unallocated_amount} currency={row.currency} showCurrency={false} />
                    {over ? <span className="block text-[11px]">asignado de más</span> : null}
                  </Td>
                  <Td>
                    <Badge variant={paymentStatusVariant(row.payment_status)}>
                      {paymentStatusLabel(row.payment_status)}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-3">
                      {row.suggested_count > 0 && Math.abs(row.unallocated_amount) <= tolerance ? (
                        <ConfirmSuggestedButton companyId={id} salesDocumentIds={[row.sales_document_id]} />
                      ) : null}
                      <Link
                        href={`/companies/${id}/sales/${row.sales_document_id}/allocations?volver=conciliar`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Asignar
                      </Link>
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </TableCard>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
            Facturas de compra sugeridas a servicios <span className="font-normal">· {costSuggestions.length}</span>
          </h2>
          {costSuggestions.length > 1 ? (
            <CostSuggestionButtons
              companyId={id}
              costDocumentIds={costSuggestions.map((row) => row.costDocumentId)}
              confirmLabel={`Confirmar las ${costSuggestions.length}`}
              showDiscard={false}
            />
          ) : null}
        </div>
        {costSuggestions.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">
            Ninguna factura de compra {allMonths ? "" : `de ${monthLabel(month)} `}espera confirmar su asignación a
            servicios recurrentes.
          </p>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Fecha</Th>
                <Th>Proveedor</Th>
                <Th>Servicios sugeridos</Th>
                <Th align="right">Neto</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {costSuggestions.map((row) => (
                <Tr key={row.costDocumentId}>
                  <Td className="whitespace-nowrap font-mono text-[12.5px] text-[var(--color-ink-2)]">
                    {formatDisplayDate(row.documentDate)}
                  </Td>
                  <Td className="font-medium text-[var(--color-ink)]">{row.supplierName ?? "—"}</Td>
                  <Td className="text-[12.5px]">
                    <ul className="flex flex-col gap-0.5">
                      {row.lines.map((line, index) => (
                        <li key={index}>
                          {line.serviceName}
                          {line.clientName ? <span className="text-[var(--color-muted)]"> · {line.clientName}</span> : null}
                          {line.period ? <span className="text-[var(--color-muted)]"> · {formatPeriod(line.period)}</span> : null}{" "}
                          <Money value={line.amount} currency={row.currency} showCurrency={false} />
                          <span className="text-[11.5px] text-[var(--color-muted)]">
                            {" "}
                            (esperado <Money value={line.expected} currency={row.currency} showCurrency={false} />)
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Td>
                  <Td align="right">
                    <Money value={row.netAmount} currency={row.currency} />
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-3">
                      <CostSuggestionButtons companyId={id} costDocumentIds={[row.costDocumentId]} />
                      <Link
                        href={`/companies/${id}/costs/${row.costDocumentId}/services`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Editar
                      </Link>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </section>

      {backedCompany ? (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
              Documentos de técnicos sugeridos <span className="font-normal">· {technicianSuggestions.length}</span>
            </h2>
            {confirmableTechnician.length > 1 ? (
              <TechnicianSuggestionButtons
                companyId={id}
                costDocumentIds={confirmableTechnician.map((row) => row.costDocumentId)}
                replacing={confirmableTechnician.filter((row) => row.document.assignment.allocated).length}
                confirmLabel={`Confirmar las ${confirmableTechnician.length}`}
                showDiscard={false}
              />
            ) : null}
          </div>
          {technicianRead.failed ? (
            <DataIncompleteBanner details={["las sugerencias de documentos de técnicos"]} />
          ) : technicianSuggestions.length === 0 ? (
            <p className="text-[12.5px] text-[var(--color-muted)]">
              Ninguna factura o boleta de técnico {allMonths ? "" : `de ${monthLabel(month)} `}espera confirmar su
              vínculo con los cargos.
            </p>
          ) : (
            <TableCard>
              <thead>
                <tr>
                  <Th>Fecha</Th>
                  <Th>Documento</Th>
                  <Th>Técnico</Th>
                  <Th>Cargos sugeridos</Th>
                  <Th align="right">Neto / bruto</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {technicianSuggestions.map((row) => (
                  <Tr key={row.costDocumentId}>
                    <Td className="whitespace-nowrap font-mono text-[12.5px] text-[var(--color-ink-2)]">
                      {formatDisplayDate(row.document.document_date)}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-[12.5px]">
                      {[row.document.source_document_type, row.document.document_number].filter(Boolean).join(" ")}
                      {row.document.assignment.allocated ? (
                        <span className="block font-sans text-[11.5px] text-[var(--color-warning-ink)]">
                          Ya asignada ({row.document.assignment.label}): se reemplaza
                        </span>
                      ) : null}
                    </Td>
                    <Td className="font-medium text-[var(--color-ink)]">{row.technicianName}</Td>
                    <Td className="text-[12.5px]">
                      <ul className="flex flex-col gap-0.5">
                        {row.charges.map((charge) => (
                          <li key={charge.id}>
                            {charge.project_name}
                            <span className="text-[var(--color-muted)]"> · {formatDisplayDate(charge.charge_date)}</span>{" "}
                            <Money value={charge.cost} currency="CLP" showCurrency={false} />
                          </li>
                        ))}
                      </ul>
                      {!row.stillValid ? (
                        <span className="block text-[11.5px] text-[var(--color-negative-ink)]">
                          Algún cargo cambió desde la sugerencia: revisalo antes de vincular.
                        </span>
                      ) : null}
                    </Td>
                    <Td align="right">
                      <Money value={row.document.net_amount} currency="CLP" />
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-3">
                        {row.stillValid ? (
                          <TechnicianSuggestionButtons
                            companyId={id}
                            costDocumentIds={[row.costDocumentId]}
                            replacing={row.document.assignment.allocated ? 1 : 0}
                          />
                        ) : null}
                        <Link
                          href={`/companies/${id}/costs/${row.costDocumentId}/technician`}
                          className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                        >
                          Editar
                        </Link>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableCard>
          )}
        </section>
      ) : null}
    </div>
  );
}
