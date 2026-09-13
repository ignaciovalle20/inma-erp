import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getCostDocumentDetail,
} from "@/lib/dal";
import { ReassignPeriodForm } from "./reassign-period-form";

const CLASSIFICATION_LABEL: Record<string, string> = {
  direct: "Direct",
  general: "General",
};

/**
 * Story 6.4: read-only detail page for a cost document -- none existed
 * before this story (only .../allocate did), so a drilled-down cost row
 * from a filtered list had nowhere to land. Deliberately read-only, no
 * edit form: see the spec's Design Notes for why building cost-document
 * editing is out of scope here.
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

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          Cost document
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          {membership.company.name}
        </p>
      </div>

      <dl className="flex flex-col gap-3 rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]">
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">Supplier</dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {document.supplier_name ?? "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">Project</dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {document.project_name ?? "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">Classification</dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {CLASSIFICATION_LABEL[document.classification] ??
              document.classification}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">Date</dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {document.document_date}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">Currency</dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {document.currency}
          </dd>
        </div>
        <div className="flex items-center justify-between border-t border-black/[.08] pt-3 dark:border-white/[.145]">
          <dt className="text-zinc-600 dark:text-zinc-400">Net amount</dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {document.net_amount}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-zinc-600 dark:text-zinc-400">Tax amount</dt>
          <dd className="font-medium text-black dark:text-zinc-50">
            {document.tax_amount}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="font-medium text-zinc-700 dark:text-zinc-300">
            Total amount
          </dt>
          <dd className="font-semibold text-black dark:text-zinc-50">
            {document.total_amount}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-medium text-black dark:text-zinc-50">
          Lines
        </h2>
        {document.lines.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            No lines recorded for this document.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {document.lines.map((line) => (
              <li
                key={line.id}
                className="flex items-center justify-between rounded-md border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145]"
              >
                <span className="text-zinc-700 dark:text-zinc-300">
                  {line.description ?? "—"}
                </span>
                <span className="font-medium text-black dark:text-zinc-50">
                  {line.amount}
                </span>
              </li>
            ))}
          </ul>
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

      {document.classification === "general" ? (
        <Link
          href={`/companies/${id}/costs/${document.id}/allocate`}
          className="text-sm font-medium text-zinc-600 underline underline-offset-2 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          View / edit allocation
        </Link>
      ) : null}

      <Link
        href={`/companies/${id}/costs`}
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to cost documents
      </Link>
    </div>
  );
}
