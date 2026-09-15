import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getImportBatchDetail,
  type ImportRow,
  type ImportRowStatus,
} from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Badge, type BadgeVariant } from "@/components/Badge";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";

const STATUS_LABEL: Record<ImportRowStatus, string> = {
  imported: "Importada",
  error: "Error",
  duplicate: "Duplicada",
};

const STATUS_BADGE_VARIANT: Record<ImportRowStatus, BadgeVariant> = {
  imported: "positive",
  error: "negative",
  duplicate: "warning",
};

const ROWS_PER_PAGE = 50;

const DUPLICATE_ID_PATTERN = /existing sales document ([0-9a-f-]{36})/i;

function shortHash(uuid: string) {
  return `${uuid.slice(0, 8)}…${uuid.slice(-4)}`;
}

type ImportBatchSearchParams = {
  status?: string;
  q?: string;
  page?: string;
};

function buildHref(
  basePath: string,
  sp: ImportBatchSearchParams,
  overrides: Partial<ImportBatchSearchParams>,
) {
  const merged = { ...sp, ...overrides };
  const next = new URLSearchParams();
  if (merged.status && merged.status !== "all") next.set("status", merged.status);
  if (merged.q) next.set("q", merged.q);
  if (merged.page && merged.page !== "1") next.set("page", merged.page);
  const qs = next.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export default async function ImportBatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; batchId: string }>;
  searchParams: Promise<ImportBatchSearchParams>;
}) {
  const { id, batchId } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const detail = await getImportBatchDetail(id, batchId);

  if (!detail) {
    redirect(`/companies/${id}/sales/import-history`);
  }

  const { batch, rows } = detail;
  const basePath = `/companies/${id}/sales/import-history/${batchId}`;
  const importedByLabel =
    batch.imported_by === user.id ? "vos" : "otro miembro del equipo";

  const activeStatus: "all" | ImportRowStatus =
    sp.status === "imported" || sp.status === "error" || sp.status === "duplicate"
      ? sp.status
      : "all";
  const query = (sp.q ?? "").trim().toLowerCase();
  const currentPage = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  // Error frequency, grouped verbatim (error_message strings are already
  // deduplicated at the source: same validation failure -> same text).
  const errorGroups = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== "error" || !row.error_message) continue;
    errorGroups.set(
      row.error_message,
      (errorGroups.get(row.error_message) ?? 0) + 1,
    );
  }
  const topErrorGroups = [...errorGroups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const dominantError = topErrorGroups[0];
  const dominantErrorShare =
    dominantError && batch.error_rows > 0
      ? Math.round((dominantError[1] / batch.error_rows) * 100)
      : 0;

  function matchesQuery(row: ImportRow) {
    if (!query) return true;
    if (String(row.row_number).includes(query)) return true;
    if (row.error_message?.toLowerCase().includes(query)) return true;
    return false;
  }

  const filteredRows = rows.filter(
    (row) => (activeStatus === "all" || row.status === activeStatus) && matchesQuery(row),
  );
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / ROWS_PER_PAGE));
  const page = Math.min(currentPage, totalPages);
  const pageRows = filteredRows.slice(
    (page - 1) * ROWS_PER_PAGE,
    page * ROWS_PER_PAGE,
  );

  const tabs: { key: "all" | ImportRowStatus; label: string; count: number }[] = [
    { key: "all", label: "Todas", count: batch.total_rows },
    { key: "imported", label: "Importadas", count: batch.imported_rows },
    { key: "error", label: "Con error", count: batch.error_rows },
    { key: "duplicate", label: "Duplicadas", count: batch.duplicate_rows },
  ];

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS / IMPORTACIÓN"
        title={batch.file_name}
        subtitle={`${membership.company.name} · ${new Date(batch.imported_at).toLocaleString("es-CL")} · ${importedByLabel}`}
        actions={
          <Link
            href={`/companies/${id}/sales/import-history`}
            className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            Volver al historial
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3.5 py-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Filas totales
          </span>
          <span className="font-mono text-[20px] font-semibold tabular-nums text-[var(--color-ink)]">
            {batch.total_rows}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] px-3.5 py-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-accent-strong)]">
            Importadas
          </span>
          <span className="font-mono text-[20px] font-semibold tabular-nums text-[var(--color-accent-strong)]">
            {batch.imported_rows}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-3.5 py-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-negative-ink)]">
            Con error
          </span>
          <span className="font-mono text-[20px] font-semibold tabular-nums text-[var(--color-negative-ink)]">
            {batch.error_rows}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] px-3.5 py-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-warning-ink)]">
            Duplicadas
          </span>
          <span className="font-mono text-[20px] font-semibold tabular-nums text-[var(--color-warning-ink)]">
            {batch.duplicate_rows}
          </span>
        </div>
      </div>

      {topErrorGroups.length > 0 ? (
        <div className="flex flex-col gap-2.5 rounded-[10px] border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-4 py-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-[var(--color-negative-ink)]">
              Errores más frecuentes
            </span>
            <span className="text-[12.5px] text-[var(--color-negative-ink)]">
              Agrupados para revisar rápido
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {topErrorGroups.map(([message, count]) => (
              <div
                key={message}
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-negative-soft)] bg-[var(--color-surface)] px-3 py-2"
              >
                <span className="text-[13px] text-[var(--color-ink-2)]">{message}</span>
                <span className="font-mono text-[13px] font-semibold tabular-nums text-[var(--color-negative-ink)]">
                  {count} fila{count === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
          {dominantError && dominantErrorShare >= 50 ? (
            <p className="text-[12.5px] text-[var(--color-negative-ink)]">
              &ldquo;{dominantError[0]}&rdquo; concentra el {dominantErrorShare}% de los
              errores — probablemente vale la pena corregir el archivo y volver a
              importar antes de revisar fila por fila.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {tabs.map((tab) => {
              const isActive = tab.key === activeStatus;
              return (
                <Link
                  key={tab.key}
                  href={buildHref(basePath, sp, { status: tab.key, page: "1" })}
                  className={`rounded-full px-3 py-[5px] text-[12.5px] no-underline ${
                    isActive
                      ? "bg-[var(--color-ink)] font-medium text-[var(--color-on-ink)]"
                      : "border border-[var(--color-hairline)] bg-[var(--color-surface)] text-[var(--color-ink-2)]"
                  }`}
                >
                  {tab.label} · {tab.count}
                </Link>
              );
            })}
          </div>
          <form method="get" className="flex items-center gap-1.5">
            {activeStatus !== "all" ? (
              <input type="hidden" name="status" value={activeStatus} />
            ) : null}
            <input
              type="text"
              name="q"
              defaultValue={sp.q ?? ""}
              placeholder="Buscar por fila o mensaje…"
              className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-[7px] text-[12.5px] text-[var(--color-ink)] placeholder:text-[var(--color-faint)]"
            />
          </form>
        </div>

        {pageRows.length === 0 ? (
          <TableCard>
            <tbody>
              <tr>
                <td>
                  <EmptyState message="No hay filas que coincidan con este filtro." />
                </td>
              </tr>
            </tbody>
          </TableCard>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Fila</Th>
                <Th>Estado</Th>
                <Th>Detalle</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const duplicateMatch =
                  row.status === "duplicate" && row.error_message
                    ? DUPLICATE_ID_PATTERN.exec(row.error_message)
                    : null;
                const duplicateDocumentId = duplicateMatch?.[1] ?? null;

                return (
                  <Tr
                    key={row.id}
                    className={
                      row.status === "error"
                        ? "bg-[var(--color-negative-row)]"
                        : row.status === "duplicate"
                          ? "bg-[var(--color-warning-row)]"
                          : ""
                    }
                  >
                    <Td className="font-mono text-[13px] text-[var(--color-ink)]">
                      {row.row_number}
                    </Td>
                    <Td>
                      <Badge variant={STATUS_BADGE_VARIANT[row.status]}>
                        {STATUS_LABEL[row.status]}
                      </Badge>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      {duplicateDocumentId ? (
                        <>
                          Posible duplicado del documento{" "}
                          <span className="font-mono">
                            {shortHash(duplicateDocumentId)}
                          </span>
                        </>
                      ) : (
                        row.error_message ?? (
                          <span className="text-[var(--color-faint)]">—</span>
                        )
                      )}
                    </Td>
                    <Td align="right">
                      {row.status === "imported" && row.sales_document_id ? (
                        <Link
                          href={`/companies/${id}/sales/${row.sales_document_id}/edit`}
                          className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                        >
                          Ver documento
                        </Link>
                      ) : duplicateDocumentId ? (
                        <Link
                          href={`/companies/${id}/sales/${duplicateDocumentId}/edit`}
                          className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                        >
                          Ver documento
                        </Link>
                      ) : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-[var(--color-surface-muted)]">
                <td colSpan={2} className="px-3 py-2.5 text-[12.5px] text-[var(--color-muted)]">
                  Mostrando {(page - 1) * ROWS_PER_PAGE + 1}–
                  {Math.min(page * ROWS_PER_PAGE, filteredRows.length)} de{" "}
                  {filteredRows.length} filas
                </td>
                <td colSpan={2} className="px-3 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {page > 1 ? (
                      <Link
                        href={buildHref(basePath, sp, { page: String(page - 1) })}
                        className="rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2.5 py-[5px] text-[12.5px] text-[var(--color-ink)] no-underline"
                      >
                        Anterior
                      </Link>
                    ) : (
                      <span className="rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2.5 py-[5px] text-[12.5px] text-[var(--color-faint)]">
                        Anterior
                      </span>
                    )}
                    {page < totalPages ? (
                      <Link
                        href={buildHref(basePath, sp, { page: String(page + 1) })}
                        className="rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2.5 py-[5px] text-[12.5px] text-[var(--color-ink)] no-underline"
                      >
                        Siguiente
                      </Link>
                    ) : (
                      <span className="rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] px-2.5 py-[5px] text-[12.5px] text-[var(--color-faint)]">
                        Siguiente
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            </tfoot>
          </TableCard>
        )}
      </div>
    </div>
  );
}
