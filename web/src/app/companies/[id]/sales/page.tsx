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

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  receipt: "Receipt",
  credit_note: "Credit note",
  manual: "Manual",
};

type SalesPageSearchParams = {
  from?: string;
  to?: string;
  clientId?: string;
  projectId?: string;
  businessAreaId?: string;
  voided?: string;
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
  const filters = {
    from: sp.from,
    to: sp.to,
    clientId: sp.clientId,
    projectId: sp.projectId,
    businessAreaId: sp.businessAreaId,
    excludeVoided: sp.voided === "exclude",
  };
  const hasActiveFilters = Boolean(
    filters.from ||
      filters.to ||
      filters.clientId ||
      filters.projectId ||
      filters.businessAreaId,
  );

  const documents = await getSalesDocuments(id, filters);

  const [filterClients, filterProjects, filterAreas] = hasActiveFilters
    ? await Promise.all([
        filters.clientId ? getClients(id) : Promise.resolve([]),
        filters.projectId ? getProjects(id) : Promise.resolve([]),
        filters.businessAreaId ? getBusinessAreas(id) : Promise.resolve([]),
      ])
    : [[], [], []];

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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Sales documents
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {membership.company.name}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {membership.company.currency === "UYU" ? (
            <Link
              href={`/companies/${id}/sales/quick`}
              className="rounded-full border border-black/[.08] px-5 py-2 text-sm font-medium text-black transition-colors hover:bg-zinc-100 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              Quick entry
            </Link>
          ) : null}
          {membership.company.country?.toUpperCase() === "CL" ? (
            <Link
              href={`/companies/${id}/sales/import`}
              className="rounded-full border border-black/[.08] px-5 py-2 text-sm font-medium text-black transition-colors hover:bg-zinc-100 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              Import
            </Link>
          ) : null}
          {membership.company.country?.toUpperCase() === "CL" ? (
            <Link
              href={`/companies/${id}/sales/import-history`}
              className="rounded-full border border-black/[.08] px-5 py-2 text-sm font-medium text-black transition-colors hover:bg-zinc-100 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-zinc-900"
            >
              Import history
            </Link>
          ) : null}
          <Link
            href={`/companies/${id}/sales/new`}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            New sales document
          </Link>
        </div>
      </div>

      {hasActiveFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/[.08] bg-zinc-50 px-4 py-3 text-sm dark:border-white/[.145] dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">Filtered:</span>
            {filters.from || filters.to ? (
              <span>
                {filters.from ?? "…"} to {filters.to ?? "…"}
              </span>
            ) : null}
            {filteredClientName ? (
              <span>· Client: {filteredClientName}</span>
            ) : null}
            {filteredProjectName ? (
              <span>· Project: {filteredProjectName}</span>
            ) : null}
            {filteredAreaName ? (
              <span>· Area: {filteredAreaName}</span>
            ) : null}
            {filters.excludeVoided ? <span>· Non-voided only</span> : null}
            <span className="font-medium text-black dark:text-zinc-50">
              · {documents.length} document{documents.length === 1 ? "" : "s"},
              net total {filteredTotal.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
          <Link
            href={`/companies/${id}/sales`}
            className="font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Clear filters
          </Link>
        </div>
      ) : null}

      {documents.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No sales documents yet for this company.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {documents.map((document) => {
            const isEdited = document.updated_at !== document.created_at;

            return (
              <li
                key={document.id}
                className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-black dark:text-zinc-50">
                      {document.client_name ?? "Unknown client"}
                    </span>
                    <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {DOCUMENT_TYPE_LABEL[document.document_type] ??
                        document.document_type}
                    </span>
                    {isEdited ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                        Edited
                      </span>
                    ) : null}
                    {document.voided ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
                        Voided
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
                  <Link
                    href={`/companies/${id}/sales/${document.id}/edit`}
                    className="text-xs font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
                  >
                    Edit
                  </Link>
                </div>
              </li>
            );
          })}
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
