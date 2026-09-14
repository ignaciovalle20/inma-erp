import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getImportBatches } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";

export default async function ImportHistoryPage({
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

  const batches = await getImportBatches(id);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Historial de importación"
        subtitle={membership.company.name}
      />

      {batches.length === 0 ? (
        <Card padding="0">
          <EmptyState
            message="Todavía no importaste documentos de venta en esta empresa."
            action={
              <LinkButton href={`/companies/${id}/sales/import`}>
                Importar documentos
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {batches.map((batch) => {
            const importedByLabel =
              batch.imported_by === user.id ? "vos" : "otro miembro del equipo";
            const hasRows = batch.total_rows > 0;
            const importedPct = hasRows
              ? Math.round((batch.imported_rows / batch.total_rows) * 100)
              : 0;
            const errorPct = hasRows
              ? Math.round((batch.error_rows / batch.total_rows) * 100)
              : 0;
            const duplicatePct = hasRows
              ? Math.round((batch.duplicate_rows / batch.total_rows) * 100)
              : 0;

            return (
              <Card key={batch.id} padding="0" className="overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-[var(--color-hairline-soft)] px-[18px] py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-[14px] font-semibold text-[var(--color-ink)]">
                        {batch.file_name}
                      </span>
                      <span className="text-[12.5px] text-[var(--color-muted)]">
                        {new Date(batch.imported_at).toLocaleString("es-CL")} ·{" "}
                        {importedByLabel}
                      </span>
                    </div>
                    {hasRows ? (
                      batch.error_rows > 0 ? (
                        <Badge variant="warning" className="whitespace-nowrap">
                          {errorPct}% con errores
                        </Badge>
                      ) : (
                        <Badge variant="positive" className="whitespace-nowrap">
                          {importedPct}% importado
                        </Badge>
                      )
                    ) : (
                      <Badge variant="neutral" className="whitespace-nowrap">
                        Sin filas
                      </Badge>
                    )}
                  </div>

                  {hasRows ? (
                    <>
                      <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-row)]">
                        <div
                          className="bg-[var(--color-accent)]"
                          style={{ width: `${importedPct}%` }}
                        />
                        <div
                          className="bg-[var(--color-negative)]"
                          style={{ width: `${errorPct}%` }}
                        />
                        <div
                          className="bg-[var(--color-warning)]"
                          style={{ width: `${duplicatePct}%` }}
                        />
                      </div>

                      <div className="flex flex-wrap gap-[18px] text-[12.5px]">
                        <span className="flex items-center gap-1.5 text-[var(--color-ink-2)]">
                          <span className="h-[7px] w-[7px] rounded-[2px] bg-[var(--color-accent)]" />
                          {batch.imported_rows} importados
                        </span>
                        <span className="flex items-center gap-1.5 text-[var(--color-ink-2)]">
                          <span className="h-[7px] w-[7px] rounded-[2px] bg-[var(--color-negative)]" />
                          {batch.error_rows} con error
                        </span>
                        <span className="flex items-center gap-1.5 text-[var(--color-ink-2)]">
                          <span className="h-[7px] w-[7px] rounded-[2px] bg-[var(--color-warning)]" />
                          {batch.duplicate_rows} duplicados
                        </span>
                        <span className="text-[var(--color-faint)]">
                          {batch.total_rows} filas totales
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
                <div className="flex items-center justify-end gap-4 px-[18px] py-2.5">
                  <Link
                    href={`/companies/${id}/sales/import-history/${batch.id}`}
                    className="text-[13px] font-medium text-[var(--color-accent-strong)]"
                  >
                    Ver detalle y errores
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Link
        href={`/companies/${id}/sales`}
        className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        Volver a documentos de venta
      </Link>
    </div>
  );
}
