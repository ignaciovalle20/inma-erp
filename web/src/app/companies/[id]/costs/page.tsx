import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getCostDocuments } from "@/lib/dal";

const CLASSIFICATION_LABEL: Record<string, string> = {
  direct: "Direct",
  general: "General",
};

export default async function CostDocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's cost
  // documents -- getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const documents = await getCostDocuments(id);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Cost documents
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {membership.company.name}
          </p>
        </div>
        <Link
          href={`/companies/${id}/costs/new`}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          New cost document
        </Link>
      </div>

      {documents.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No cost documents yet for this company.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-black dark:text-zinc-50">
                    {document.supplier_name ?? "—"}
                  </span>
                  <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {CLASSIFICATION_LABEL[document.classification] ??
                      document.classification}
                  </span>
                  {document.classification === "direct" &&
                  document.project_name ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-400">
                      {document.project_name}
                    </span>
                  ) : null}
                </div>
                <span className="text-sm text-zinc-500 dark:text-zinc-500">
                  {document.document_date} · {document.currency}
                </span>
              </div>
              <div className="flex flex-col items-end gap-1 text-sm">
                <span className="text-zinc-500 dark:text-zinc-500">
                  Net {document.net_amount} + Tax {document.tax_amount}
                </span>
                <span className="font-medium text-black dark:text-zinc-50">
                  Total {document.total_amount}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link
        href="/companies"
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to companies
      </Link>
    </div>
  );
}
