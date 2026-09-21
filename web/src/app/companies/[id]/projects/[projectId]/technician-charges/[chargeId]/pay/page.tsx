import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSession, getCompanyForEdit, getProjects } from "@/lib/dal";
import { getTechnicianCharges, type TechnicianCharge } from "@/lib/technicianDal";
import { PaymentForm } from "../../../../../personnel/[personnelId]/account/payment-form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { formatAmount } from "@/components/Money";

/**
 * Pays what a job owes one technician, from the job itself: the form starts as
 * "pay it all" for this charge, and a partial payment is just a smaller amount.
 * A payment that covers several charges is made from the technician's account.
 */
export default async function PayTechnicianChargePage({
  params,
}: {
  params: Promise<{ id: string; projectId: string; chargeId: string }>;
}) {
  const { id, projectId, chargeId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const projects = await getProjects(id);
  const project = projects.find((candidate) => candidate.id === projectId);

  if (!project) {
    notFound();
  }

  const projectHref = `/companies/${id}/projects/${projectId}`;
  const back = { href: projectHref, label: "Volver al trabajo" };

  let charge: TechnicianCharge | null = null;
  let readFailed = false;
  try {
    const charges = await getTechnicianCharges(id, { projectId });
    charge = charges.find((candidate) => candidate.id === chargeId) ?? null;
  } catch (error) {
    console.error(error);
    readFailed = true;
  }

  if (readFailed) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
        <DataIncompleteBanner details={["el cargo del técnico"]} />
        <Link href={projectHref} className="text-[13px] text-[var(--color-muted)]">
          Volver al trabajo
        </Link>
      </div>
    );
  }

  if (!charge) {
    notFound();
  }

  const currency = membership.company.currency;
  const accountHref = `/companies/${id}/personnel/${charge.personnel_id}/account`;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title="Registrar pago a técnico"
        subtitle={[project.name, charge.personnel_name].filter(Boolean).join(" · ")}
        back={back}
      />
      <Card padding="24px">
        {charge.outstanding <= 0 ? (
          <div className="flex flex-col gap-3 text-[13px] text-[var(--color-ink-2)]" role="status">
            <p>Este cargo ya está pagado por completo: no queda nada por registrar.</p>
            <Link href={accountHref} className="font-medium text-[var(--color-accent-strong)]">
              Ver los pagos en la cuenta corriente del técnico
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-[var(--color-ink-2)]">
              {charge.personnel_name} cobra{" "}
              <strong className="font-mono">{formatAmount(charge.amount, currency)}</strong> por este trabajo
              {charge.description ? ` (${charge.description})` : ""}
              {charge.paid > 0 ? (
                <>
                  ; ya se le pagaron <span className="font-mono">{formatAmount(charge.paid, currency)}</span> y
                  falta <strong className="font-mono">{formatAmount(charge.outstanding, currency)}</strong>
                </>
              ) : null}
              .
            </p>
            <PaymentForm
              companyId={id}
              personnelId={charge.personnel_id}
              projectId={projectId}
              currency={currency}
              openCharges={[
                {
                  id: charge.id,
                  charge_date: charge.charge_date,
                  project_name: charge.project_name,
                  description: charge.description,
                  outstanding: charge.outstanding,
                },
              ]}
            />
            <p className="border-t border-[var(--color-hairline)] pt-3 text-[12px] text-[var(--color-muted)]">
              ¿Un solo pago que cubre varios trabajos del técnico? Registralo desde su{" "}
              <Link href={accountHref} className="font-medium text-[var(--color-accent-strong)]">
                cuenta corriente
              </Link>
              .
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
