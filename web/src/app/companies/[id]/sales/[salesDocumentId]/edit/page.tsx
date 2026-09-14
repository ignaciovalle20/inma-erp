import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getClients,
  getProjects,
  getSalesDocumentForEdit,
  getImportRowBatchInfo,
} from "@/lib/dal";
import { EditSalesDocumentForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

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

  const [document, clients, projects] = await Promise.all([
    getSalesDocumentForEdit(id, salesDocumentId),
    getClients(id),
    getProjects(id),
  ]);

  if (!document) {
    redirect(`/companies/${id}/sales`);
  }

  const activeClients = clients.filter((client) => client.active);
  // Include the document's currently-tagged project even if it's no
  // longer active, so editing the document doesn't silently drop it
  // from the picker.
  const activeProjects = projects.filter(
    (project) => project.status === "active" || project.id === document.project_id,
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
      {document.voided ? (
        <Card className="flex flex-col gap-3">
          <p className="text-[13px] text-[var(--color-ink-2)]">
            Este documento fue anulado y ya no puede editarse.
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
