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

  const document = await getSalesDocumentForEdit(id, salesDocumentId);

  if (!document) {
    redirect(`/companies/${id}/sales`);
  }

  const clients = await getClients(id);
  const activeClients = clients.filter((client) => client.active);
  const projects = await getProjects(id);
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
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Edit sales document
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
        {importInfo ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            Imported from {importInfo.file_name}, row {importInfo.row_number}{" "}
            ·{" "}
            <Link
              href={`/companies/${id}/sales/import-history/${importInfo.import_batch_id}`}
              className="font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              View batch
            </Link>
          </p>
        ) : null}
      </div>
      {document.voided ? (
        <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          <p>
            This document was voided and can no longer be edited.
          </p>
          <a
            className="font-medium text-black underline dark:text-zinc-50"
            href={`/companies/${id}/sales`}
          >
            Back to sales documents
          </a>
        </div>
      ) : (
        <EditSalesDocumentForm
          companyId={id}
          document={document}
          clients={activeClients}
          projects={activeProjects}
        />
      )}
    </div>
  );
}
