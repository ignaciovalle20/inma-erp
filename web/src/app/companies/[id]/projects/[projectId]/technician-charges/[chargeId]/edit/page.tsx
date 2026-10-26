import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSession, getCompanyForEdit, getProjects, getPersonnelForEdit } from "@/lib/dal";
import { getTechnicianCharges, getWithholdingRates, type TechnicianCharge } from "@/lib/technicianDal";
import { enteredValueOf, type Backing, type WithholdingRate } from "@/lib/technicians";
import { ChargeForm } from "../../charge-form";
import { DeleteChargeForm } from "../../delete-charge-form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { formatAmount } from "@/components/Money";

export default async function EditTechnicianChargePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; projectId: string; chargeId: string }>;
  searchParams: Promise<{ volver?: string }>;
}) {
  const { id, projectId, chargeId } = await params;
  const { volver } = await searchParams;
  // Back to where the correction was asked from (the link screen of a document), within this company.
  const returnTo =
    volver && volver.startsWith(`/companies/${id}/`) && !volver.includes("//") ? volver : undefined;
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

  let charge: TechnicianCharge | null = null;
  let readFailed = false;
  try {
    const charges = await getTechnicianCharges(id, { projectId });
    charge = charges.find((candidate) => candidate.id === chargeId) ?? null;
  } catch (error) {
    console.error(error);
    readFailed = true;
  }

  const projectHref = `/companies/${id}/projects/${projectId}`;
  const currency = membership.company.currency;

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

  const technician = await getPersonnelForEdit(id, charge.personnel_id);
  const hasPayments = charge.paid > 0;
  const backed = charge.backing !== null;
  let withholdingRates: WithholdingRate[] = [];
  if (backed) {
    try {
      withholdingRates = await getWithholdingRates();
    } catch (error) {
      console.error(error);
    }
  }
  const initial = backed ? enteredValueOf({ ...charge, backing: charge.backing as Backing }) : null;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title="Corregir cargo de técnico"
        subtitle={[project.name, charge.personnel_name].filter(Boolean).join(" · ")}
        back={{ href: projectHref, label: "Volver al trabajo" }}
      />
      <Card padding="24px">
        {charge.linked_document ? (
          <div className="flex flex-col gap-3 text-[13px] text-[var(--color-ink-2)]" role="status">
            <p>
              Este cargo está vinculado a la {charge.backing === "boleta" ? "boleta" : "factura"}{" "}
              <strong className="font-mono">
                {[charge.linked_document.source_document_type, charge.linked_document.document_number]
                  .filter(Boolean)
                  .join(" ")}
              </strong>
              , que es el costo del trabajo. Para cambiar el monto, el respaldo o eliminarlo, primero desvinculá el
              documento.
            </p>
            <Link
              href={`/companies/${id}/costs/${charge.linked_document.id}/technician`}
              className="font-medium text-[var(--color-accent-strong)]"
            >
              Ver el vínculo del documento
            </Link>
          </div>
        ) : hasPayments ? (
          <div className="flex flex-col gap-3 text-[13px] text-[var(--color-ink-2)]" role="status">
            <p>
              Este cargo ya tiene <strong className="font-mono">{formatAmount(charge.paid, currency)}</strong>{" "}
              pagados al técnico, así que no se puede corregir ni eliminar.
            </p>
            <p>
              Para cambiarlo, primero borrá ese pago en la{" "}
              <Link
                href={`/companies/${id}/personnel/${charge.personnel_id}/account`}
                className="font-medium text-[var(--color-accent-strong)]"
              >
                cuenta corriente del técnico
              </Link>{" "}
              y volvé a registrarlo después.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <ChargeForm
              mode="edit"
              companyId={id}
              projectId={projectId}
              chargeId={chargeId}
              technicians={[
                {
                  id: charge.personnel_id,
                  name: charge.personnel_name,
                  payment_document: technician?.payment_document ?? null,
                  default_backing: technician?.default_backing ?? "none",
                  default_rates: technician?.default_rates ?? {},
                },
              ]}
              currency={currency}
              vatRate={charge.vat_rate}
              backed={backed}
              withholdingRates={withholdingRates}
              returnTo={returnTo}
              initialValues={{
                personnel_id: charge.personnel_id,
                charge_date: charge.charge_date,
                description: charge.description ?? "",
                amount: String(initial ? initial.value : charge.amount),
                vat_included: charge.vat_included,
                backing: charge.backing ?? "",
                entered_as: initial ? initial.enteredAs : "",
              }}
            />
            <div className="border-t border-[var(--color-hairline)] pt-4">
              <p className="mb-2 text-[12px] text-[var(--color-muted)]">
                ¿Está cargado a otro técnico o a otro trabajo? Eliminalo y cargalo de nuevo.
              </p>
              <DeleteChargeForm companyId={id} projectId={projectId} chargeId={chargeId} />
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
