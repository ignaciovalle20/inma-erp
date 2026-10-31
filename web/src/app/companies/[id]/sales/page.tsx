import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getClients,
  getProjects,
  getBusinessAreas,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { Card } from "@/components/Card";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { currentMonth, monthLabel, resolvePeriod, shiftMonth } from "@/lib/period";
import {
  PAYMENT_STATUS_LABEL,
  formatDisplayDate,
  hasPaymentStatus,
  isOverdue,
  paymentStatusLabel,
  paymentStatusVariant,
} from "@/lib/paymentStatus";
import { getRateTable } from "@/lib/exchangeRates";
import { negateSummary } from "@/lib/multiCurrency";
import { todayForCountry } from "@/lib/recurringServicePending";
import { MoneyBreakdown } from "@/components/MoneyBreakdown";
import { VoidDocumentRowAction } from "./VoidDocumentRowAction";
import {
  BULK_PAYMENT_FORM_ID,
  PaymentStatusRowAction,
  SalesBulkPaymentBar,
  SelectAllSales,
} from "./PaymentStatusControls";
import { SalesFilterFields } from "./SalesFilterFields";
import { ProjectSearch } from "../projects/search";
import { listUrl, withVolver } from "@/lib/backNavigation";
import {
  SEARCH_PAGE_SIZE,
  loadSalesView,
  summarizeRows,
  type SalesSearchParams,
  type SalesViewRow,
} from "./salesView";

const PAGE_SIZE = SEARCH_PAGE_SIZE;

const DOCUMENT_PREFIX: Record<string, string> = {
  invoice: "FAC",
  credit_note: "N/C",
  receipt: "REC",
  manual: "Manual",
};

function documentLabel(row: SalesViewRow): string {
  const prefix = DOCUMENT_PREFIX[row.document_type] ?? row.document_type;
  return row.document_number ? `${prefix} ${row.document_number}` : prefix;
}

export default async function SalesDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SalesSearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's sales
  // documents -- getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const currency = membership.company.currency;
  const today = todayForCountry(membership.company.country);

  const [view, filterClients, filterProjects, filterAreas, rates] = await Promise.all([
    loadSalesView(id, sp, currency),
    getClients(id),
    getProjects(id),
    getBusinessAreas(id),
    getRateTable(),
  ]);

  const { filters, rows: documents, search } = view;
  const sortBy = filters.sortBy === "net" ? "net" : "date";
  const sortDirection = filters.sortDirection === "asc" ? "asc" : "desc";

  // The month on screen (null = the whole history). The cards below add up
  // exactly what the list shows, so they never mix months.
  const period = resolvePeriod(sp);
  const totals = summarizeRows(documents, currency, rates);

  // Filters other than the month (the month has its own navigator).
  const hasOtherFilters =
    !search &&
    Boolean(
      filters.clientId ||
        filters.projectId ||
        filters.businessAreaId ||
        filters.paymentStatus ||
        filters.recurring ||
        sp.voided === "include",
    );

  // A search already comes as one page from the database; the month's list is
  // read whole (its totals cover every page) and cut here.
  const listTotal = search ? search.total : documents.length;
  const totalPages = Math.max(1, Math.ceil(listTotal / PAGE_SIZE));
  const currentPage = search
    ? search.page
    : Math.min(totalPages, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));
  if (search && search.total > 0 && currentPage > totalPages) {
    redirect(`/companies/${id}/sales?${new URLSearchParams({ q: search.query, page: String(totalPages) }).toString()}`);
  }
  const pageDocuments = search ? documents : documents.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  // What the search box keeps when it changes: the view it was opened from.
  const searchKeep = Object.fromEntries(
    Object.entries(sp).filter(([key, value]) => key !== "q" && key !== "page" && typeof value === "string"),
  ) as Record<string, string>;

  const filteredClientName = filterClients.find((client) => client.id === filters.clientId)?.name;
  const filteredProjectName = filterProjects.find((project) => project.id === filters.projectId)?.name;
  const filteredAreaName = filterAreas.find((area) => area.id === filters.businessAreaId)?.name;

  // Every link keeps the filters on screen; the month is always written out
  // (period=all for the whole history) so that a link never falls back to
  // the default month by accident. Changing anything resets the page.
  function hrefWith(changes: Partial<Record<keyof SalesSearchParams, string | null>>) {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v && k !== "page" && k !== "period") next.set(k, v);
    }
    next.set("period", period ?? "all");
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else if (v !== undefined) next.set(k, v);
    }
    return `/companies/${id}/sales?${next.toString()}`;
  }

  function chipHrefWithout(key: keyof SalesSearchParams) {
    return hrefWith({ [key]: null });
  }

  // Clicking the currently-active sort column flips its direction;
  // clicking the other one switches to it at that column's natural
  // default (most recent / highest first).
  function sortHref(column: "date" | "net") {
    const nextDirection = sortBy === column && sortDirection === "desc" ? "asc" : "desc";
    return hrefWith({ sort: column, order: nextDirection });
  }

  function sortIndicator(column: "date" | "net") {
    if (sortBy !== column) return null;
    return <span className="ml-1 text-[var(--color-faint)]">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  }

  // The export covers what is on screen: the month (or the whole history)
  // and every filter, not just the page being shown.
  const exportQuery = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v && k !== "page" && k !== "period") exportQuery.set(k, v);
  }
  exportQuery.set("period", period ?? "all");

  // What this list is right now, so the pages it opens can come back to it.
  const volver = listUrl(`/companies/${id}/sales`, sp as Record<string, string | undefined>);

  const chip =
    "rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Ventas"
        subtitle={membership.company.name}
        actions={
          <>
            {/* Same buttons for every company; what differs by country
                lives in lib/companyConfig.ts. */}
            <LinkButton href={`/companies/${id}/sales/quick`} variant="secondary">
              Carga rápida
            </LinkButton>
            <LinkButton href={`/companies/${id}/sales/import`} variant="secondary">
              Importar
            </LinkButton>
            <LinkButton href={`/companies/${id}/sales/import-history`} variant="secondary">
              Historial de importación
            </LinkButton>
            <LinkButton href={`/companies/${id}/sales/pending`} variant="secondary">
              Pendientes
            </LinkButton>
            <LinkButton href={`/companies/${id}/sales/reconcile`} variant="secondary">
              Conciliar
            </LinkButton>
            {/* A plain <a>: this is a file download, not a page to prefetch. */}
            <a
              href={`/companies/${id}/sales/export${exportQuery.toString() ? `?${exportQuery.toString()}` : ""}`}
              className="inline-flex min-h-9 items-center whitespace-nowrap rounded-control border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 text-body font-medium text-[var(--color-ink)] no-underline hover:border-[var(--color-border-hover)] hover:text-[var(--color-ink)]"
            >
              Exportar
            </a>
            <LinkButton href={`/companies/${id}/sales/new`} variant="primary">
              Nuevo documento
            </LinkButton>
          </>
        }
      />

      {view.error ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-3 py-2.5 text-[13px] text-[var(--color-negative-ink)]"
        >
          {view.error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <ProjectSearch
          basePath={`/companies/${id}/sales`}
          query={search?.query ?? ""}
          keep={searchKeep}
          placeholder="Buscar en todo el historial: folio, cliente, RUT o trabajo"
          label="Buscar documentos de venta"
        />
        {search ? (
          <span className="text-[12.5px] text-[var(--color-muted)]">
            {search.total} resultado{search.total === 1 ? "" : "s"} en todo el historial, anuladas incluidas.
          </span>
        ) : null}
      </div>

      {search ? null : (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          {
            label: period ? `Total de ${monthLabel(period)}` : "Total del historial",
            summary: totals.net,
            subtotal: "Neto",
          },
          { label: "Facturado", summary: totals.invoiced, subtotal: "Facturado" },
          { label: "Notas de crédito", summary: negateSummary(totals.creditNotes), subtotal: "N/C" },
        ].map((card) => (
          <Card key={card.label} className="flex min-w-0 flex-col gap-2">
            <span className="caps-label text-[var(--color-muted)]">{card.label} · neto sin IVA</span>
            {card.summary.byCurrency.length === 0 ? (
              <Money value={0} currency={currency} className="text-[20px] font-semibold text-[var(--color-ink)]" />
            ) : (
              card.summary.byCurrency.map((subtotal) => (
                <div key={subtotal.currency} className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] text-[var(--color-muted)]">
                    {card.subtotal} {subtotal.currency}
                  </span>
                  <Money
                    value={subtotal.amount}
                    currency={subtotal.currency}
                    className="text-[18px] font-semibold text-[var(--color-ink)]"
                  />
                </div>
              ))
            )}
            <MoneyBreakdown
              summary={card.summary}
              label="Total combinado"
              showSubtotals={false}
              className="border-t border-[var(--color-hairline-soft)] pt-1.5"
            />
          </Card>
        ))}
      </div>
      )}

      {search ? null : (
      <form
        method="get"
        className="surface-card flex flex-wrap items-end gap-3 p-3"
      >
        <div className="flex w-full flex-col gap-1 sm:w-auto">
          <label htmlFor="period" className="field-label">
            Período
          </label>
          <input
            id="period"
            type="month"
            name="period"
            defaultValue={period ?? ""}
            aria-label="Mes y año"
            className="control"
          />
        </div>
        <SalesFilterFields
          clients={filterClients}
          projects={filterProjects}
          areas={filterAreas}
          defaultClientId={filters.clientId ?? ""}
          defaultProjectId={filters.projectId ?? ""}
          defaultBusinessAreaId={filters.businessAreaId ?? ""}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="payment" className="field-label">
            Estado de pago
          </label>
          <select
            id="payment"
            name="payment"
            defaultValue={filters.paymentStatus ?? ""}
            aria-label="Estado de pago"
            className="control"
          >
            <option value="">Todas</option>
            <option value="pagado">Pagadas</option>
            <option value="impago">Impagas</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="recurring" className="field-label">
            Origen
          </label>
          <select
            id="recurring"
            name="recurring"
            defaultValue={filters.recurring ?? ""}
            aria-label="Origen del documento"
            className="control"
          >
            <option value="">Todos</option>
            <option value="recurring">Recurrentes</option>
            <option value="non_recurring">No recurrentes</option>
          </select>
        </div>
        <label className="flex min-h-9 items-center gap-2 text-body text-[var(--color-ink-2)]">
          <input type="checkbox" name="voided" value="include" defaultChecked={sp.voided === "include"} />
          Incluir anuladas
        </label>
        <button
          type="submit"
          className="inline-flex min-h-9 items-center rounded-control border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 text-body font-medium text-[var(--color-ink)] hover:border-[var(--color-border-hover)]"
        >
          Filtrar
        </button>
      </form>
      )}

      {search ? null : (
      <div className="flex flex-wrap items-center gap-2">
        {period ? (
          <>
            <Link href={hrefWith({ period: shiftMonth(period, -1) })} className={chip} aria-label="Mes anterior">
              ◀
            </Link>
            <span className="min-w-[130px] text-center text-[13.5px] font-semibold capitalize text-[var(--color-ink)]">
              {monthLabel(period)}
            </span>
            <Link href={hrefWith({ period: shiftMonth(period, 1) })} className={chip} aria-label="Mes siguiente">
              ▶
            </Link>
            <Link href={hrefWith({ period: "all" })} className="text-[12.5px] text-[var(--color-accent-strong)]">
              Ver todo el historial
            </Link>
          </>
        ) : (
          <>
            <span className="text-[13.5px] font-semibold text-[var(--color-ink)]">
              {filters.from || filters.to ? `${filters.from ?? "…"} → ${filters.to ?? "…"}` : "Todo el historial"}
            </span>
            <Link href={hrefWith({ period: currentMonth(), from: null, to: null })} className="text-[12.5px] text-[var(--color-accent-strong)]">
              Ver el mes actual
            </Link>
          </>
        )}
      </div>
      )}

      {hasOtherFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] px-4 py-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] tracking-[0.1em] text-[var(--color-accent-muted)]">
              FILTRADO
            </span>
            {filteredClientName ? (
              <Link href={chipHrefWithout("clientId")} className={chip}>
                {filteredClientName} ✕
              </Link>
            ) : null}
            {filteredProjectName ? (
              <Link href={chipHrefWithout("projectId")} className={chip}>
                {filteredProjectName} ✕
              </Link>
            ) : null}
            {filteredAreaName ? (
              <Link href={chipHrefWithout("businessAreaId")} className={chip}>
                {filteredAreaName} ✕
              </Link>
            ) : null}
            {filters.paymentStatus ? (
              <Link href={chipHrefWithout("payment")} className={chip}>
                {PAYMENT_STATUS_LABEL[filters.paymentStatus]}s ✕
              </Link>
            ) : null}
            {filters.recurring ? (
              <Link href={chipHrefWithout("recurring")} className={chip}>
                {filters.recurring === "recurring" ? "Recurrentes" : "No recurrentes"} ✕
              </Link>
            ) : null}
            {sp.voided === "include" ? (
              <Link href={chipHrefWithout("voided")} className={chip}>
                Con anuladas ✕
              </Link>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <span className="flex flex-wrap items-center gap-1 text-[12.5px] font-medium text-[var(--color-accent-strong)]">
              {totals.count} documento{totals.count === 1 ? "" : "s"} · neto{" "}
              <MoneyBreakdown summary={totals.net} variant="inline" label="total" />
            </span>
            <Link
              href={`/companies/${id}/sales?period=${period ?? "all"}`}
              className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
            >
              Limpiar
            </Link>
          </div>
        </div>
      ) : null}

      {documents.length > 0 ? <SalesBulkPaymentBar companyId={id} /> : null}

      {documents.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState
                  message={
                    view.error
                      ? "No se pudo cargar el listado (ver el error de arriba)."
                      : search
                        ? `No hay documentos de venta que coincidan con “${search.query}”.`
                        : "No hay documentos de venta con estos filtros."
                  }
                  action={
                    view.error ? undefined : (
                      <LinkButton href={`/companies/${id}/sales/new`}>Nuevo documento</LinkButton>
                    )
                  }
                />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>
                <SelectAllSales />
              </Th>
              <Th>
                <Link href={sortHref("date")} className="text-inherit no-underline hover:text-[var(--color-ink)]">
                  Fecha{sortIndicator("date")}
                </Link>
              </Th>
              <Th>Folio</Th>
              <Th>Cliente</Th>
              <Th>Área</Th>
              <Th>Trabajo</Th>
              <Th align="right">
                <Link href={sortHref("net")} className="text-inherit no-underline hover:text-[var(--color-ink)]">
                  Neto{sortIndicator("net")}
                </Link>
              </Th>
              <Th align="right">Gasto ({currency})</Th>
              <Th align="right">Ganancia ({currency})</Th>
              <Th align="right">Margen</Th>
              <Th>Pago</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {pageDocuments.map((document) => {
              const isEdited = document.updated_at !== document.created_at;
              const isCreditNote = document.document_type === "credit_note";
              const dash = <span className="text-[var(--color-faint)]">—</span>;

              return (
                <Tr key={document.id} className={document.voided ? "opacity-70" : ""}>
                  <Td>
                    {document.voided || !hasPaymentStatus(document.document_type) ? null : (
                      <input
                        type="checkbox"
                        name="ids"
                        value={document.id}
                        form={BULK_PAYMENT_FORM_ID}
                        aria-label={`Seleccionar ${documentLabel(document)}`}
                      />
                    )}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[12.5px] text-[var(--color-ink-2)]">
                    {formatDisplayDate(document.document_date)}
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[12.5px] text-[var(--color-ink)]">
                    {documentLabel(document)}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-[var(--color-ink)]">
                        {document.client_name ?? "Cliente desconocido"}
                      </span>
                      {document.is_recurring ? <Badge variant="neutral">Recurrente</Badge> : null}
                      {isEdited ? <Badge variant="warning">Editado</Badge> : null}
                      {document.voided ? (
                        <Badge variant="negative">
                          {document.annulment_partner_number
                            ? document.annulled_by_document_id
                              ? `Anulada por N/C ${document.annulment_partner_number}`
                              : `Anula la FAC ${document.annulment_partner_number}`
                            : "Anulado"}
                        </Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">{document.business_area_name ?? dash}</Td>
                  <Td className="text-[var(--color-ink-2)]">
                    {document.project_id ? (
                      <Link
                        href={withVolver(`/companies/${id}/projects/${document.project_id}`, volver)}
                        className="text-[var(--color-accent-strong)] no-underline"
                      >
                        {document.project_name ?? "Trabajo"}
                      </Link>
                    ) : (
                      dash
                    )}
                    {(() => {
                      // Split among jobs (allocations): project_id names the largest.
                      const others = new Set(
                        document.parts
                          .map((part) => part.projectId)
                          .filter((projectId) => projectId && projectId !== document.project_id),
                      ).size;
                      return others > 0 ? (
                        <Link
                          href={withVolver(`/companies/${id}/sales/${document.id}/allocations`, volver)}
                          className="block text-[11px] text-[var(--color-muted)]"
                        >
                          +{others} trabajo{others === 1 ? "" : "s"}
                        </Link>
                      ) : null;
                    })()}
                  </Td>
                  <Td
                    align="right"
                    className={isCreditNote ? "text-[var(--color-negative-ink)]" : "text-[var(--color-ink)]"}
                  >
                    <Money
                      value={isCreditNote ? -document.net_amount : document.net_amount}
                      currency={document.currency}
                      showCurrency={document.currency !== currency}
                    />
                    {document.attributed_net !== null && document.attributed_net !== document.net_amount ? (
                      <span className="block text-[11px] text-[var(--color-muted)]" title="Parte de la factura asignada a este filtro">
                        aquí{" "}
                        <Money
                          value={isCreditNote ? -document.attributed_net : document.attributed_net}
                          currency={document.currency}
                          showCurrency={false}
                        />
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right" className="text-[var(--color-muted)]">
                    {document.cost === null ? (
                      dash
                    ) : (
                      <Money value={document.cost} currency={currency} showCurrency={false} />
                    )}
                  </Td>
                  <Td align="right" className="text-[var(--color-ink)]">
                    {document.profit === null ? (
                      dash
                    ) : (
                      <Money value={document.profit} currency={currency} showCurrency={false} />
                    )}
                  </Td>
                  <Td align="right" className="font-mono text-[12.5px] text-[var(--color-ink-2)]">
                    {document.marginPct === null ? dash : `${document.marginPct.toFixed(0)}%`}
                  </Td>
                  <Td>
                    {document.payment_status && hasPaymentStatus(document.document_type) ? (
                      <div className="flex flex-col items-start gap-0.5">
                        <Badge variant={paymentStatusVariant(document.payment_status)}>
                          {paymentStatusLabel(document.payment_status)}
                        </Badge>
                        {document.payment_status === "pagado" && document.paid_at ? (
                          <span className="font-mono text-[11px] text-[var(--color-faint)]">
                            {formatDisplayDate(document.paid_at)}
                          </span>
                        ) : null}
                        {document.payment_status === "impago" && document.due_date ? (
                          <span
                            className={`font-mono text-[11px] ${
                              isOverdue(document, today)
                                ? "text-[var(--color-negative-ink)]"
                                : "text-[var(--color-faint)]"
                            }`}
                          >
                            {isOverdue(document, today) ? "vencida" : "vence"} {formatDisplayDate(document.due_date)}
                          </span>
                        ) : null}
                        {document.voided ? null : (
                          <PaymentStatusRowAction
                            companyId={id}
                            salesDocumentId={document.id}
                            status={document.payment_status}
                          />
                        )}
                      </div>
                    ) : (
                      dash
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-2">
                      {document.voided || isCreditNote ? null : (
                        <Link
                          href={withVolver(`/companies/${id}/sales/${document.id}/allocations`, volver)}
                          className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                        >
                          Asignar
                        </Link>
                      )}
                      <Link
                        href={withVolver(`/companies/${id}/sales/${document.id}/edit`, volver)}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Editar
                      </Link>
                      {document.voided ? null : (
                        <VoidDocumentRowAction companyId={id} salesDocumentId={document.id} />
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-[var(--color-surface-muted)]">
              <td colSpan={6} className="px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]">
                {totals.count} documento{totals.count === 1 ? "" : "s"} contados
                {totalPages > 1 ? (search ? " (esta página)" : " (todas las páginas)") : ""}
                {totals.voided > 0
                  ? ` (${totals.voided} anulado${totals.voided === 1 ? "" : "s"} no suma${totals.voided === 1 ? "" : "n"})`
                  : ""}
              </td>
              <td className="px-3 py-2.5 text-right text-[12.5px] font-semibold text-[var(--color-ink)]">
                <MoneyBreakdown summary={totals.net} label="Total" subtotalLabel="Neto" />
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-[13px] text-[var(--color-muted)]">
                {totals.hasCost ? <Money value={totals.cost} currency={currency} showCurrency={false} /> : null}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-[13px] font-semibold text-[var(--color-ink)]">
                {totals.hasCost ? <Money value={totals.profit} currency={currency} showCurrency={false} /> : null}
              </td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </TableCard>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-[12.5px] text-[var(--color-muted)]">
          <span>
            Mostrando {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, listTotal)} de {listTotal}
          </span>
          <div className="flex items-center gap-3">
            {currentPage > 1 ? (
              <Link
                href={hrefWith({ page: String(currentPage - 1) })}
                className="font-medium text-[var(--color-accent-strong)]"
              >
                Anterior
              </Link>
            ) : null}
            <span>
              Página {currentPage} de {totalPages}
            </span>
            {currentPage < totalPages ? (
              <Link
                href={hrefWith({ page: String(currentPage + 1) })}
                className="font-medium text-[var(--color-accent-strong)]"
              >
                Siguiente
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
