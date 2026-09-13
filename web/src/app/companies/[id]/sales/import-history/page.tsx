import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getImportBatches } from "@/lib/dal";

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
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Import history
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>

      {batches.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No imports yet for this company.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {batches.map((batch) => {
            const importedByLabel =
              batch.imported_by === user.id ? "You" : "Another team member";

            return (
              <li
                key={batch.id}
                className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-black dark:text-zinc-50">
                    {batch.file_name}
                  </span>
                  <span className="text-sm text-zinc-500 dark:text-zinc-500">
                    {new Date(batch.imported_at).toLocaleString()} ·{" "}
                    {importedByLabel}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1 text-sm">
                  <span className="text-zinc-500 dark:text-zinc-500">
                    {batch.imported_rows} imported · {batch.error_rows} errors
                    · {batch.duplicate_rows} duplicates
                  </span>
                  <Link
                    href={`/companies/${id}/sales/import-history/${batch.id}`}
                    className="text-xs font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
                  >
                    View detail
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Link
        href={`/companies/${id}/sales`}
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to sales documents
      </Link>
    </div>
  );
}
