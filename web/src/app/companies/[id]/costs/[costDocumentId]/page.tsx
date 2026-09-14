import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getCostDocumentDetail,
  getCostAllocations,
  type CostAllocationTargetType,
} from "@/lib/dal";
import { allocationTotals, rowShare } from "@/lib/allocations";
import { ReassignPeriodForm, formatPeriod } from "./reassign-period-form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { LinkButton } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { AllocationBar, allocationColor } from "@/components/AllocationBar";

const CLASSIFICATION_LABEL: Record<string, string> = {
  direct: "Directo",
  general: "General",
};

const TARGET_TYPE_LABEL: Record<CostAllocationTargetType, string> = {
  project: "Proyecto",
  client: "Cliente",
  business_area: "Área",
};

/**
 * Story 6.4: read-only detail page for a cost document -- deliberately
 * read-only, no edit form (see the spec's Design Notes for why building
 * cost-document editing is out of scope here). §1a redesign: header
 * badges + a totals card replace the old 8-row `<dl>`, and the
 * allocation summary (previously just a link out to /allocate) is
 * rendered inline with its own bar and per-target breakdown.
 */
export default async function CostDocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string; costDocumentId: string }>;
}) {
  const { id, costDocumentId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const document = await getCostDocumentDetail(id, costDocumentId);

  if (!document) {
    redirect(`/companies/${id}/costs`);
  }

  const allocations =
    document.classification === "general"
      ? await getCostAllocations(costDocumentId)
      : [];

  const allocationRows = allocations.map((allocation) => ({
    method: allocation.method,
    value: String(
      allocation.method === "percentage"
        ? (allocation.percentage ?? 0)
        : (allocation.amount ?? 0),
    ),
  }));
  const totals = allocationTotals(allocationRows, document.total_amount);

  const allocationSegments = allocations.map((allocation, index) => {
    const share = rowShare(allocationRows[index], document.total_amount);
    return {
      label: allocation.target_name ?? TARGET_TYPE_LABEL[allocation.target_type],
      share: document.total_amount > 0 ? share / document.total_amount : 0,
      color: allocationColor(index).color,
    };
  });

  const allocationBadge =
    document.classification === "general" ? (
      allocations.length === 0 ? (
        <Badge variant="warning">Sin asignar</Badge>
      ) : totals.matches ? (
        <Badge variant="positive">Asignado 100%</Badge>
      ) : (
        <Badge variant="warning">
          {`Falta ${
            document.total_amount > 0
              ? Math.round((totals.missing / document.total_amount) * 100)
              : 0
          }%`}
        </Badge>
      )
    ) : null;

  const recognizedPeriodLabel = document.recognized_period
    ? formatPeriod(document.recognized_period)
    : formatPeriod(`${document.document_date.slice(0, 7)}-01`);

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / DOCUMENTO"
        title="Documento de costo"
        subtitle={`${membership.company.name} · ${document.document_date}`}
        actions={
          <>
            <Badge variant={document.classification === "direct" ? "positive" : "neutral"}>
              {CLASSIFICATION_LABEL[document.classification] ?? document.classification}
            </Badge>
            {allocationBadge}
          </>
        }
      />

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Total
            </span>
            <Money
              value={document.total_amount}
              currency={document.currency}
              className="text-[22px] font-semibold text-[var(--color-ink)]"
            />
          </div>
          <div className="flex flex-col items-end gap-1 text-[12.5px] text-[var(--color-ink-2)]">
            <span>
              Neto{" "}
              <Money value={document.net_amount} currency={document.currency} showCurrency={false} />
            </span>
            <span>
              IVA{" "}
              <Money value={document.tax_amount} currency={document.currency} showCurrency={false} />
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 border-t border-[var(--color-hairline)] pt-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Proveedor
            </span>
            <span className="text-[13px] text-[var(--color-ink)]">
              {document.supplier_name ?? "—"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Proyecto
            </span>
            <span className="text-[13px] text-[var(--color-ink)]">
              {document.project_name ?? "—"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Reconocido en
            </span>
            <span className="text-[13px] text-[var(--color-ink)]">
              {recognizedPeriodLabel}
            </span>
          </div>
        </div>
      </Card>

      {document.classification === "general" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
              Asignación
            </span>
            {allocations.length > 0 ? (
              <Link
                href={`/companies/${id}/costs/${document.id}/allocate`}
                className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
              >
                Editar asignación
              </Link>
            ) : null}
          </div>
          <Card className="flex flex-col gap-3">
            {allocations.length === 0 ? (
              <EmptyState
                message="Este costo general todavía no tiene un reparto definido."
                action={
                  <LinkButton
                    href={`/companies/${id}/costs/${document.id}/allocate`}
                    variant="secondary"
                  >
                    Asignar este costo
                  </LinkButton>
                }
              />
            ) : (
              <>
                <AllocationBar segments={allocationSegments} />
                <ul className="flex flex-col gap-2">
                  {allocations.map((allocation, index) => {
                    const share = rowShare(allocationRows[index], document.total_amount);
                    const pct =
                      document.total_amount > 0 ? (share / document.total_amount) * 100 : 0;
                    const { color, opacity } = allocationColor(index);
                    return (
                      <li
                        key={allocation.id}
                        className="flex items-center gap-2.5 text-[12.5px]"
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: color, opacity }}
                        />
                        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-muted)]">
                          {TARGET_TYPE_LABEL[allocation.target_type]}
                        </span>
                        <span className="flex-1 truncate text-[var(--color-ink)]">
                          {allocation.target_name ?? "—"}
                        </span>
                        <span className="text-[var(--color-ink-2)]">{pct.toFixed(1)}%</span>
                        <Money
                          value={share}
                          currency={document.currency}
                          showCurrency={false}
                          className="font-medium text-[var(--color-ink)]"
                        />
                      </li>
                    );
                  })}
                </ul>
                <div
                  className={`rounded-[8px] px-3 py-2 text-[12.5px] ${
                    totals.matches
                      ? "border border-[var(--color-accent-soft-border)] bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]"
                      : "border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-soft)] text-[var(--color-warning-ink)]"
                  }`}
                >
                  {totals.matches ? (
                    "Asignado completo · sin faltante"
                  ) : (
                    <>
                      Falta{" "}
                      <Money value={totals.missing} currency={document.currency} /> por
                      asignar
                    </>
                  )}
                </div>
              </>
            )}
          </Card>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
          Líneas
        </span>
        {document.lines.length === 0 ? (
          <p className="text-[12.5px] text-[var(--color-muted)]">
            No hay líneas registradas para este documento.
          </p>
        ) : (
          <Card padding="0" className="overflow-hidden">
            <ul className="flex flex-col">
              {document.lines.map((line) => (
                <li
                  key={line.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--color-hairline-soft)] px-4 py-2.5 text-[13px] last:border-b-0"
                >
                  <span className="text-[var(--color-ink-2)]">
                    {line.description ? line.description.replaceAll("--", "—") : "—"}
                  </span>
                  <Money
                    value={line.amount}
                    currency={document.currency}
                    showCurrency={false}
                    className="font-medium text-[var(--color-ink)]"
                  />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <ReassignPeriodForm
        companyId={id}
        costDocumentId={document.id}
        recognizedPeriod={document.recognized_period}
        recognizedPeriodSetBy={document.recognized_period_set_by}
        recognizedPeriodSetAt={document.recognized_period_set_at}
        currentUserId={user.id}
        currentUserEmail={user.email ?? null}
      />

      <Link
        href={`/companies/${id}/costs`}
        className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        Volver a documentos de costo
      </Link>
    </div>
  );
}
