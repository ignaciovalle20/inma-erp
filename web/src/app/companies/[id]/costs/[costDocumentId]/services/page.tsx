import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getCostDocumentDetail, getCostAllocations } from "@/lib/dal";
import { getCostPeriodTargets, getCostPeriods, getCostServiceAllocations } from "@/lib/costServiceAllocations";
import { splitByLargestRemainder } from "@/lib/costAllocationSuggestions";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { ServiceAllocationForm, type ServicePeriodOption } from "./form";

/**
 * "Asignar a servicios": a supplier's purchase invoice -> the cost periods
 * of recurring services (cost_service_allocations, 20261020010000). Opens
 * with the invoice's current allocation, or the period asked for
 * (?period=, from a service's page), or every period of the invoice's
 * month of that supplier's services, split by their expected cost.
 */
export default async function AssignCostToServicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; costDocumentId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id, costDocumentId } = await params;
  const { period: preselectedPeriod } = await searchParams;
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

  const month = (document.recognized_period ?? document.document_date).slice(0, 7);
  const [targets, existing, costAllocations] = await Promise.all([
    getCostPeriodTargets(id, month),
    getCostServiceAllocations(id, { costDocumentId }),
    document.classification === "general" ? getCostAllocations(costDocumentId) : Promise.resolve([]),
  ]);

  const blocker =
    document.classification !== "general" || document.project_id
      ? "Este costo ya está imputado a un trabajo: solo un costo general sin trabajo se asigna a servicios."
      : costAllocations.length > 0
        ? 'Este costo ya tiene un reparto ("Dividir"). Quitá ese reparto para asignarlo a servicios.'
        : document.covered_by_cost_pool_id
          ? "Esta factura ya está en el reparto de licencias MS de su mes."
          : null;

  const options: ServicePeriodOption[] = targets
    .map((target) => ({
      id: target.id,
      serviceName: target.serviceName,
      clientName: target.clientName,
      period: target.period,
      currency: target.currency,
      expected: target.expected,
      sameSupplier: Boolean(document.supplier_id) && target.supplierId === document.supplier_id,
    }))
    .sort(
      (a, b) =>
        Number(b.sameSupplier) - Number(a.sameSupplier) ||
        a.period.localeCompare(b.period) ||
        a.serviceName.localeCompare(b.serviceName, "es"),
    );
  // A period already allocated here stays selectable even outside the window.
  const optionIds = new Set(options.map((option) => option.id));
  const missingIds = existing.map((row) => row.costPeriodId).filter((periodId) => !optionIds.has(periodId));
  for (const target of await getCostPeriods(id, { periodIds: missingIds })) {
    options.push({
      id: target.id,
      serviceName: target.serviceName,
      clientName: target.clientName,
      period: target.period,
      currency: target.currency,
      expected: target.expected,
      sameSupplier: Boolean(document.supplier_id) && target.supplierId === document.supplier_id,
    });
    optionIds.add(target.id);
  }

  let initialRows: { cost_period_id: string; amount: string }[];
  const preselected =
    preselectedPeriod && optionIds.has(preselectedPeriod)
      ? options.find((option) => option.id === preselectedPeriod)!
      : null;
  if (existing.length > 0 || preselected) {
    initialRows = existing.map((row) => ({ cost_period_id: row.costPeriodId, amount: String(row.amount) }));
    if (preselected && !initialRows.some((row) => row.cost_period_id === preselected.id)) {
      const left = Math.max(0, document.net_amount - existing.reduce((sum, row) => sum + row.amount, 0));
      const amount = preselected.expected > 0 ? Math.min(preselected.expected, left) : left;
      initialRows.push({ cost_period_id: preselected.id, amount: amount > 0 ? String(amount) : "" });
    }
  } else {
    const ofMonth = options.filter(
      (option) => option.sameSupplier && option.period.slice(0, 7) === month && option.currency === document.currency,
    );
    const amounts = splitByLargestRemainder(
      document.net_amount,
      ofMonth.map((option) => (option.expected > 0 ? option.expected : 1)),
      document.currency,
    );
    initialRows = ofMonth.map((option, index) => ({ cost_period_id: option.id, amount: String(amounts[index]) }));
  }

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / DOCUMENTO"
        title="Asignar a servicios"
        subtitle={`${document.supplier_name ?? "Sin proveedor"} · ${document.document_date}`}
        back={{ href: `/companies/${id}/costs/${costDocumentId}`, label: "Documento de costo" }}
      />
      {blocker ? (
        <div className="flex flex-col gap-3 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] p-4 text-[13px] text-[var(--color-warning-ink)]">
          <p>{blocker}</p>
          <LinkButton href={`/companies/${id}/costs/${costDocumentId}`} variant="secondary" className="w-fit">
            Volver al documento
          </LinkButton>
        </div>
      ) : (
        <ServiceAllocationForm
          companyId={id}
          documentId={costDocumentId}
          netAmount={document.net_amount}
          currency={document.currency}
          options={options}
          initialRows={initialRows}
        />
      )}
    </div>
  );
}
