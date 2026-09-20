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
import {
  PAYMENT_STATUS_OPTIONS,
  formatDisplayDate,
  paymentStatusLabel,
  paymentStatusVariant,
} from "@/lib/paymentStatus";
import { VoidDocumentRowAction } from "./VoidDocumentRowAction";
import { SalesFilterFields } from "./SalesFilterFields";
import {
  currentMonth,
  loadSalesView,
  resolvePeriod,
  shiftMonth,
  summarizeRows,
  type SalesSearchParams,
  type SalesViewRow,
} from "./salesView";

const PAGE_SIZE = 100;

const MONTH_NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

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
  const isChile = membership.company.country?.toUpperCase() === "CL";

  const [view, filterClients, filterProjects, filterAreas] = await Promise.all([
    loadSalesView(id, sp),
    getClients(id),
    getProjects(id),
    getBusinessAreas(id),
  ]);

  const { filters, rows: documents } = view;
  const sortBy = filters.sortBy === "net" ? "net" : "date";
  const sortDirection = filters.sortDirection === "asc" ? "asc" : "desc";

  // The month on screen (null = the whole history). The cards below add up
  // exactly what the list shows, so they never mix months.
  const period = resolvePeriod(sp);
  const totals = summarizeRows(documents);
  const totalAmount = totals.net;
  const invoicedAmount = totals.invoiced;
  const creditNoteAmount = totals.creditNotes;

  // Filters other than the month (the month has its own navigator).
  const hasOtherFilters = Boolean(
    filters.clientId ||
      filters.projectId ||
      filters.businessAreaId ||
      filters.paymentStatus ||
      sp.voided === "include",
  );

  const totalPages = Math.max(1, Math.ceil(documents.length / PAGE_SIZE));
  const currentPage = Math.min(totalPages, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));
  const pageDocuments = documents.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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

  const chip =
    "rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline";

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Ventas"
        subtitle={membership.company.name}
        actions={
          <>
            {currency === "UYU" ? (
              <LinkButton href={`/companies/${id}/sales/quick`} variant="secondary">
                Carga rápida
              </LinkButton>
            ) : null}
            {isChile ? (
              <LinkButton href={`/companies/${id}/sales/import`} variant="secondary">
                Importar
              </LinkButton>
            ) : null}
            {isChile ? (
              <LinkButton href={`/companies/${id}/sales/import-history`} variant="secondary">
                Historial de importación
              </LinkButton>
            ) : null}
            <LinkButton href={`/companies/${id}/sales/pending`} variant="secondary">
              Pendientes
            </LinkButton>
            {/* A plain <a>: this is a file download, not a page to prefetch. */}
            <a
              href={`/companies/${id}/sales/export${exportQuery.toString() ? `?${exportQuery.toString()}` : ""}`}
              className="inline-flex items-center rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 py-[7px] text-[13px] font-medium text-[var(--color-ink)] no-underline hover:border-[var(--color-border-hover)]"
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

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              {period ? `Total de ${monthLabel(period)}` : "Total del historial"}
            </span>
            <Money
              value={totalAmount}
              currency={currency}
              className="text-[20px] font-semibold text-[var(--color-ink)]"
            />
          </div>
        </Card>
        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Facturado
            </span>
            <Money
              value={invoicedAmount}
              currency={currency}
              className="text-[20px] font-semibold text-[var(--color-ink)]"
            />
          </div>
        </Card>
        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Notas de crédito
            </span>
            <Money
              value={-creditNoteAmount}
              currency={currency}
              className="text-[20px] font-semibold text-[var(--color-ink)]"
            />
          </div>
        </Card>
      </div>

      <form
        method="get"
        className="flex flex-wrap items-center gap-2.5 rounded-[9px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-2.5"
      >
        <input
          type="month"
          name="period"
          defaultValue={period ?? ""}
          aria-label="Mes y año"
          className="rounded-lg border border-[var(--color-hairline)] px-3 py-[7px] text-[13px] text-[var(--color-ink)]"
        />
        <SalesFilterFields
          clients={filterClients}
          projects={filterProjects}
          areas={filterAreas}
          defaultClientId={filters.clientId ?? ""}
          defaultProjectId={filters.projectId ?? ""}
          defaultBusinessAreaId={filters.businessAreaId ?? ""}
        />
        <select
          name="payment"
          defaultValue={filters.paymentStatus ?? ""}
          aria-label="Estado de cobro"
          className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-[7px] text-[13px] text-[var(--color-ink)]"
        >
          <option value="">Todo cobro</option>
          {PAYMENT_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {paymentStatusLabel(status)}
            </option>
          ))}
          <option value="sin_dato">Sin dato</option>
        </select>
        <label className="flex items-center gap-1.5 text-[12.5px] text-[var(--color-ink-2)]">
          <input type="checkbox" name="voided" value="include" defaultChecked={sp.voided === "include"} />
          Mostrar anuladas
        </label>
        <button
          type="submit"
          className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink)]"
        >
          Filtrar
        </button>
      </form>

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
                Cobro: {filters.paymentStatus === "sin_dato" ? "sin dato" : paymentStatusLabel(filters.paymentStatus)} ✕
              </Link>
            ) : null}
            {sp.voided === "include" ? (
              <Link href={chipHrefWithout("voided")} className={chip}>
                Con anuladas ✕
              </Link>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] font-medium text-[var(--color-accent-strong)]">
              {totals.count} documento{totals.count === 1 ? "" : "s"} · neto{" "}
              <Money value={totals.net} currency={currency} />
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

      {documents.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState
                  message={
                    view.error
                      ? "No se pudo cargar el listado (ver el error de arriba)."
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
              <Th align="right">Gasto</Th>
              <Th align="right">Ganancia</Th>
              <Th align="right">Margen</Th>
              <Th>Cobro</Th>
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
                        href={`/companies/${id}/projects/${document.project_id}`}
                        className="text-[var(--color-accent-strong)] no-underline"
                      >
                        {document.project_name ?? "Trabajo"}
                      </Link>
                    ) : (
                      dash
                    )}
                  </Td>
                  <Td
                    align="right"
                    className={isCreditNote ? "text-[var(--color-negative-ink)]" : "text-[var(--color-ink)]"}
                  >
                    <Money
                      value={isCreditNote ? -document.net_amount : document.net_amount}
                      currency={document.currency}
                      showCurrency={false}
                    />
                  </Td>
                  <Td align="right" className="text-[var(--color-muted)]">
                    {document.cost === null ? (
                      dash
                    ) : (
                      <Money value={document.cost} currency={document.currency} showCurrency={false} />
                    )}
                  </Td>
                  <Td align="right" className="text-[var(--color-ink)]">
                    {document.profit === null ? (
                      dash
                    ) : (
                      <Money value={document.profit} currency={document.currency} showCurrency={false} />
                    )}
                  </Td>
                  <Td align="right" className="font-mono text-[12.5px] text-[var(--color-ink-2)]">
                    {document.marginPct === null ? dash : `${document.marginPct.toFixed(0)}%`}
                  </Td>
                  <Td>
                    {document.payment_status ? (
                      <div className="flex flex-col gap-0.5">
                        <Badge variant={paymentStatusVariant(document.payment_status)}>
                          {paymentStatusLabel(document.payment_status)}
                        </Badge>
                        {document.due_date &&
                        (document.payment_status === "por_vencer" || document.payment_status === "vencido") ? (
                          <span className="font-mono text-[11px] text-[var(--color-faint)]">
                            vence {formatDisplayDate(document.due_date)}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      dash
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-2">
                      <Link
                        href={`/companies/${id}/sales/${document.id}/edit`}
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
              <td colSpan={5} className="px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]">
                {totals.count} documento{totals.count === 1 ? "" : "s"} contados
                {totalPages > 1 ? " (todas las páginas)" : ""}
                {documents.length !== totals.count
                  ? ` (${documents.length - totals.count} anulado${documents.length - totals.count === 1 ? "" : "s"} no suma${documents.length - totals.count === 1 ? "" : "n"})`
                  : ""}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-[13px] font-semibold text-[var(--color-ink)]">
                <Money value={totals.net} currency={currency} showCurrency={false} />
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
            Mostrando {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, documents.length)} de{" "}
            {documents.length}
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
