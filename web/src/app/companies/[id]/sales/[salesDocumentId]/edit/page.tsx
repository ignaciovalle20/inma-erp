import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getClients,
  getProjects,
  getSalesDocumentForEdit,
  getSalesDocumentBilling,
  getImportRowBatchInfo,
} from "@/lib/dal";
import { EditSalesDocumentForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { formatDisplayDate, paymentStatusLabel, paymentStatusVariant } from "@/lib/paymentStatus";

export default async function EditSalesDocumentPage({
  params,
}: {
  params: Promise<{ id: string; salesDocumentId: string }>;
}) {
  const { id, salesDocumentId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [document, clients, projects, billing] = await Promise.all([
    getSalesDocumentForEdit(id, salesDocumentId),
    getClients(id),
    getProjects(id),
    getSalesDocumentBilling(id, salesDocumentId),
  ]);

  if (!document) {
    redirect(`/companies/${id}/sales`);
  }

  const activeClients = clients.filter((client) => client.active);
  // Include the document's currently-tagged project even if it's no
  // longer active, so editing the document doesn't silently drop it
  // from the picker.
  const activeProjects = projects.filter(
    (project) =>
      (project.status !== "cerrado" && project.status !== "cancelado") ||
      project.id === document.project_id,
  );

  const importInfo =
    document.source === "import" && document.import_row_id
      ? await getImportRowBatchInfo(document.import_row_id)
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS"
        title="Editar documento de venta"
        subtitle={
          importInfo
            ? `${membership.company.name} · importado de ${importInfo.file_name}, fila ${importInfo.row_number}`
            : membership.company.name
        }
        actions={
          importInfo ? (
            <Link
              href={`/companies/${id}/sales/import-history/${importInfo.import_batch_id}`}
              className="text-[13px] font-medium text-[var(--color-accent-strong)]"
            >
              Ver lote
            </Link>
          ) : undefined
        }
      />
      {billing && (billing.document_number || billing.payment_status) ? (
        <Card className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-[var(--color-ink-2)]">
          {billing.document_number ? (
            <span>
              Folio <span className="font-mono text-[var(--color-ink)]">{billing.document_number}</span>
            </span>
          ) : null}
          {billing.payment_status ? (
            <span className="flex items-center gap-1.5">
              Cobro
              <Badge variant={paymentStatusVariant(billing.payment_status)}>
                {paymentStatusLabel(billing.payment_status)}
              </Badge>
            </span>
          ) : null}
          {billing.due_date ? (
            <span>
              Vence <span className="font-mono">{formatDisplayDate(billing.due_date)}</span>
            </span>
          ) : null}
          {billing.paid_at ? (
            <span>
              Pagada el <span className="font-mono">{formatDisplayDate(billing.paid_at)}</span>
              {billing.payment_method ? ` · ${billing.payment_method}` : ""}
            </span>
          ) : null}
          {billing.annulled_by_number ? (
            <Badge variant="negative">Anulada por N/C {billing.annulled_by_number}</Badge>
          ) : null}
          {billing.annuls_number ? (
            <Badge variant="negative">Anula la factura {billing.annuls_number}</Badge>
          ) : null}
        </Card>
      ) : null}
      {document.voided ? (
        <Card className="flex flex-col gap-3">
          <p className="text-[13px] text-[var(--color-ink-2)]">
            {billing?.annulled_by_number || billing?.annuls_number
              ? "Este documento está anulado por una nota de crédito (las dos quedan fuera de las ventas) y no puede editarse."
              : "Este documento fue anulado y ya no puede editarse."}
          </p>
          <Link
            href={`/companies/${id}/sales`}
            className="text-[13px] font-medium text-[var(--color-accent-strong)]"
          >
            Volver a ventas
          </Link>
        </Card>
      ) : (
        <EditSalesDocumentForm
          companyId={id}
          document={document}
          clients={activeClients}
          projects={activeProjects}
          currentUserId={user.id}
          currentUserEmail={user.email ?? null}
        />
      )}
    </div>
  );
}
