import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getSalesDocuments,
  getClients,
  getProjects,
  getBusinessAreas,
} from "@/lib/dal";
import { monthRange } from "@/lib/reporting";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { Card } from "@/components/Card";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { VoidDocumentRowAction } from "./VoidDocumentRowAction";
import { SalesFilterFields } from "./SalesFilterFields";

// Net_amount is always stored as a positive magnitude regardless of
// document_type (see reporting.ts's own revenueSign) -- a credit note
// reduces revenue, so it's subtracted here rather than added, same
// sign convention the monthly-result/profitability reports use.
function revenueSign(documentType: string, amount: number): number {
  return documentType === "credit_note" ? -amount : amount;
}

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  invoice: "Factura",
  receipt: "Recibo",
  credit_note: "Nota de crédito",
  manual: "Manual",
};

type SalesPageSearchParams = {
  from?: string;
  to?: string;
  clientId?: string;
  projectId?: string;
  businessAreaId?: string;
  voided?: string;
  sort?: string;
  order?: string;
  // "YYYY-MM", from the visible month/year filter control -- resolved
  // below into from/to, same [start, end) convention as the drill-down
  // from/to links already use, so both can share one query shape.
  period?: string;
};

export default async function SalesDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SalesPageSearchParams>;
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

  // Story 6.4: drill-down filters, plain GET query params -- no new
  // state/session mechanism, per spec Boundaries. `voided=exclude` is
  // what report links pass, since every reporting figure that sums
  // sales_documents excludes voided ones.
  const sortBy = sp.sort === "total" ? "total" : "date";
  const sortDirection = sp.order === "asc" ? "asc" : "desc";

  const periodRange = /^\d{4}-\d{2}$/.test(sp.period ?? "")
    ? monthRange(`${sp.period}-01`)
    : null;

  const filters = {
    from: periodRange?.start ?? sp.from,
    to: periodRange?.end ?? sp.to,
    clientId: sp.clientId,
    projectId: sp.projectId,
    businessAreaId: sp.businessAreaId,
    excludeVoided: sp.voided === "exclude",
    sortBy,
    sortDirection,
  } as const;
  const hasActiveFilters = Boolean(
    filters.from ||
      filters.to ||
      filters.clientId ||
      filters.projectId ||
      filters.businessAreaId,
  );

  const [documents, filterClients, filterProjects, filterAreas, monthDocuments] =
    await Promise.all([
      getSalesDocuments(id, filters),
      getClients(id),
      getProjects(id),
      getBusinessAreas(id),
      // Summary cards use their own always-non-voided, unfiltered fetch
      // (mirroring the costs list's own monthDocuments) so they read as
      // a stable business figure regardless of whatever the list below
      // is currently filtered/sorted to.
      getSalesDocuments(id, { excludeVoided: true }),
    ]);

  const totalAmount = monthDocuments.reduce(
    (sum, document) => sum + revenueSign(document.document_type, document.net_amount),
    0,
  );
  const invoicedAmount = monthDocuments
    .filter((document) => document.document_type !== "credit_note")
    .reduce((sum, document) => sum + document.net_amount, 0);
  const creditNoteAmount = monthDocuments
    .filter((document) => document.document_type === "credit_note")
    .reduce((sum, document) => sum + document.net_amount, 0);

  const filteredClientName = filterClients.find(
    (client) => client.id === filters.clientId,
  )?.name;
  const filteredProjectName = filterProjects.find(
    (project) => project.id === filters.projectId,
  )?.name;
  const filteredAreaName = filterAreas.find(
    (area) => area.id === filters.businessAreaId,
  )?.name;

  const filteredTotal = documents.reduce(
    (sum, document) => sum + Number(document.net_amount ?? 0),
    0,
  );

  function chipHrefWithout(key: keyof SalesPageSearchParams) {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v && k !== key) next.set(k, v);
    }
    const qs = next.toString();
    return `/companies/${id}/sales${qs ? `?${qs}` : ""}`;
  }

  // Clicking the currently-active sort column flips its direction;
  // clicking the other one switches to it at that column's natural
  // default (most recent / highest first).
  function sortHref(column: "date" | "total") {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (v && k !== "sort" && k !== "order") next.set(k, v);
    }
    const nextDirection = sortBy === column && sortDirection === "desc" ? "asc" : "desc";
    next.set("sort", column);
    next.set("order", nextDirection);
    return `/companies/${id}/sales?${next.toString()}`;
  }

  function sortIndicator(column: "date" | "total") {
    if (sortBy !== column) return null;
    return <span className="ml-1 text-[var(--color-faint)]">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Ventas"
        subtitle={membership.company.name}
        actions={
          <>
            {membership.company.currency === "UYU" ? (
              <LinkButton href={`/companies/${id}/sales/quick`} variant="secondary">
                Carga rápida
              </LinkButton>
            ) : null}
            {membership.company.country?.toUpperCase() === "CL" ? (
              <LinkButton href={`/companies/${id}/sales/import`} variant="secondary">
                Importar
              </LinkButton>
            ) : null}
            {membership.company.country?.toUpperCase() === "CL" ? (
              <LinkButton
                href={`/companies/${id}/sales/import-history`}
                variant="secondary"
              >
                Historial de importación
              </LinkButton>
            ) : null}
            <LinkButton href={`/companies/${id}/sales/new`} variant="primary">
              Nuevo documento
            </LinkButton>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <Card className="flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Total del mes
            </span>
            <Money
              value={totalAmount}
              currency={membership.company.currency}
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
              currency={membership.company.currency}
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
              currency={membership.company.currency}
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
          defaultValue={sp.period ?? ""}
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
        <button
          type="submit"
          className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink)]"
        >
          Filtrar
        </button>
      </form>

      {hasActiveFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[9px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] px-4 py-[11px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[10px] tracking-[0.1em] text-[var(--color-accent-muted)]">
              FILTRADO
            </span>
            {sp.period ? (
              <Link
                href={chipHrefWithout("period")}
                className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline"
              >
                {sp.period} ✕
              </Link>
            ) : filters.from || filters.to ? (
              <span className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)]">
                {filters.from ?? "…"} → {filters.to ?? "…"}
              </span>
            ) : null}
            {filteredClientName ? (
              <Link
                href={chipHrefWithout("clientId")}
                className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline"
              >
                {filteredClientName} ✕
              </Link>
            ) : null}
            {filteredProjectName ? (
              <Link
                href={chipHrefWithout("projectId")}
                className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline"
              >
                {filteredProjectName} ✕
              </Link>
            ) : null}
            {filteredAreaName ? (
              <Link
                href={chipHrefWithout("businessAreaId")}
                className="rounded-md border border-[var(--color-accent-soft-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[12px] text-[var(--color-accent-strong)] no-underline"
              >
                {filteredAreaName} ✕
              </Link>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] font-medium text-[var(--color-accent-strong)]">
              {documents.length} documento{documents.length === 1 ? "" : "s"} ·
              neto{" "}
              <Money value={filteredTotal} currency={membership.company.currency} />
            </span>
            <Link
              href={`/companies/${id}/sales`}
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
                  message="No hay documentos de venta en este período."
                  action={
                    <LinkButton href={`/companies/${id}/sales/new`}>
                      Nuevo documento
                    </LinkButton>
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
              <Th>Cliente / Proyecto</Th>
              <Th>Tipo</Th>
              <Th align="right">Neto</Th>
              <Th align="right">IVA</Th>
              <Th align="right">
                <Link href={sortHref("total")} className="text-inherit no-underline hover:text-[var(--color-ink)]">
                  Total{sortIndicator("total")}
                </Link>
              </Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => {
              const isEdited = document.updated_at !== document.created_at;
              return (
                <Tr key={document.id}>
                  <Td className="font-mono text-[12.5px] text-[var(--color-ink-2)]">
                    {document.document_date}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-[var(--color-ink)]">
                        {document.client_name ?? "Cliente desconocido"}
                      </span>
                      {isEdited ? <Badge variant="warning">Editado</Badge> : null}
                      {document.voided ? (
                        <Badge variant="negative">Anulado</Badge>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <Badge variant="outline">
                      {DOCUMENT_TYPE_LABEL[document.document_type] ??
                        document.document_type}
                    </Badge>
                  </Td>
                  <Td align="right">
                    <Money
                      value={document.net_amount}
                      currency={document.currency}
                      showCurrency={false}
                    />
                  </Td>
                  <Td align="right" className="text-[var(--color-muted)]">
                    <Money
                      value={document.tax_amount}
                      currency={document.currency}
                      showCurrency={false}
                    />
                  </Td>
                  <Td
                    align="right"
                    className={`font-semibold ${
                      document.voided
                        ? "text-[var(--color-faint)]"
                        : document.total_amount < 0
                          ? "text-[var(--color-negative-ink)]"
                          : "text-[var(--color-ink)]"
                    }`}
                  >
                    <Money
                      value={document.total_amount}
                      currency={document.currency}
                      showCurrency={false}
                    />
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
                        <VoidDocumentRowAction
                          companyId={id}
                          salesDocumentId={document.id}
                        />
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-[var(--color-surface-muted)]">
              <td colSpan={3} className="px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]">
                Mostrando {documents.length} de {documents.length} documentos
              </td>
              <td colSpan={4} className="px-3 py-2.5 text-right font-mono text-[13px] font-semibold text-[var(--color-ink)]">
                <Money value={filteredTotal} currency={membership.company.currency} />
              </td>
            </tr>
          </tfoot>
        </TableCard>
      )}
    </div>
  );
}
