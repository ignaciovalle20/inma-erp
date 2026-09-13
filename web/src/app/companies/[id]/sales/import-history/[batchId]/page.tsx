import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getImportBatchDetail,
} from "@/lib/dal";

const STATUS_LABEL: Record<string, string> = {
  imported: "Imported",
  error: "Error",
  duplicate: "Duplicate",
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  imported:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  error: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  duplicate:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
};

export default async function ImportBatchDetailPage({
  params,
}: {
  params: Promise<{ id: string; batchId: string }>;
}) {
  const { id, batchId } = await params;
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
  const importedByLabel =
    batch.imported_by === user.id ? "You" : "Another team member";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          {batch.file_name}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name} ·{" "}
          {new Date(batch.imported_at).toLocaleString()} · {importedByLabel}
        </p>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {batch.total_rows} rows total · {batch.imported_rows} imported ·{" "}
          {batch.error_rows} errors · {batch.duplicate_rows} duplicates
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          This batch has no rows.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-black dark:text-zinc-50">
                    Row {row.row_number}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_BADGE_CLASS[row.status] ??
                      "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    {STATUS_LABEL[row.status] ?? row.status}
                  </span>
                </div>
                {row.error_message ? (
                  <span className="text-sm text-zinc-500 dark:text-zinc-500">
                    {row.error_message}
                  </span>
                ) : null}
              </div>
              {row.status === "imported" && row.sales_document_id ? (
                <Link
                  href={`/companies/${id}/sales/${row.sales_document_id}/edit`}
                  className="text-xs font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
                >
                  View sales document
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/companies/${id}/sales/import-history`}
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to import history
      </Link>
    </div>
  );
}
