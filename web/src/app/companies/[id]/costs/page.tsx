import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getCostDocuments,
  getProjects,
  type CostClassification,
} from "@/lib/dal";

const CLASSIFICATION_LABEL: Record<string, string> = {
  direct: "Direct",
  general: "General",
};

type CostsPageSearchParams = {
  from?: string;
  to?: string;
  projectId?: string;
  classification?: string;
  // Client/area profitability drill-downs roll up several projects at
  // once -- resolved below into a projectIds filter, since cost_documents
  // has no client_id/business_area_id column of its own.
  clientId?: string;
  businessAreaId?: string;
};

export default async function CostDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<CostsPageSearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
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

  // Story 6.4: drill-down filters, plain GET query params -- no new
  // state/session mechanism, per spec Boundaries.
  const classification =
    sp.classification === "direct" || sp.classification === "general"
      ? (sp.classification as CostClassification)
      : undefined;

  const needsProjectLookup = Boolean(
    sp.projectId || sp.clientId || sp.businessAreaId,
  );
  const allProjects = needsProjectLookup ? await getProjects(id) : [];

  // A client/area's cost figure rolls up every project tagged to it
  // (see computeClientProfitability/computeAreaProfitability) --
  // resolved here into a project id list, since cost_documents has no
  // client_id/business_area_id of its own to filter on directly. This
  // only covers each project's own direct costs, not cost_allocations
  // shares targeting the client/area directly (those aren't separately
  // listable rows -- noted inline below, same caveat the spec accepts
  // for project drill-downs).
  const projectIds = sp.clientId
    ? allProjects
        .filter((project) => project.client_id === sp.clientId)
        .map((project) => project.id)
    : sp.businessAreaId
      ? allProjects
          .filter((project) => project.business_area_id === sp.businessAreaId)
          .map((project) => project.id)
      : undefined;

  const filters = {
    from: sp.from,
    to: sp.to,
    projectId: sp.projectId,
    projectIds,
    classification,
  };
  const hasActiveFilters = Boolean(
    filters.from ||
      filters.to ||
      filters.projectId ||
      (filters.projectIds && filters.projectIds.length > 0) ||
      filters.classification,
  );
  const isRollup = Boolean(sp.clientId || sp.businessAreaId);

  const documents = await getCostDocuments(id, filters);

  const filteredProjectName = sp.projectId
    ? allProjects.find((project) => project.id === sp.projectId)?.name
    : undefined;

  const filteredTotal = documents.reduce(
    (sum, document) => sum + Number(document.net_amount ?? 0),
    0,
  );

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

      {hasActiveFilters ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-black/[.08] bg-zinc-50 px-4 py-3 text-sm dark:border-white/[.145] dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">Filtered:</span>
            {filters.from || filters.to ? (
              <span>
                {filters.from ?? "…"} to {filters.to ?? "…"}
              </span>
            ) : null}
            {filteredProjectName ? (
              <span>· Project: {filteredProjectName}</span>
            ) : null}
            {filters.classification ? (
              <span>
                · {CLASSIFICATION_LABEL[filters.classification] ??
                  filters.classification}
              </span>
            ) : null}
            <span className="font-medium text-black dark:text-zinc-50">
              · {documents.length} document{documents.length === 1 ? "" : "s"},
              net total {filteredTotal.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
          <Link
            href={`/companies/${id}/costs`}
            className="font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Clear filters
          </Link>
        </div>
      ) : null}

      {isRollup ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          This list shows each project&apos;s own direct cost documents.
          Shared/overhead costs allocated to this client or area (via
          general cost documents) are included in the report figure but
          aren&apos;t separately listable rows here.
        </p>
      ) : null}

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
                  {document.classification === "general" &&
                  document.is_allocated ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                      Allocated
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
                  href={`/companies/${id}/costs/${document.id}`}
                  className="text-xs font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
                >
                  View
                </Link>
                {document.classification === "general" ? (
                  <Link
                    href={`/companies/${id}/costs/${document.id}/allocate`}
                    className="text-xs font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
                  >
                    {document.is_allocated ? "Edit allocation" : "Allocate"}
                  </Link>
                ) : null}
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
