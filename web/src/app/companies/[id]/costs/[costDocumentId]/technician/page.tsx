import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getPersonnel, getProjects, type Personnel, type ProjectWithRelations } from "@/lib/dal";
import { companyConfig } from "@/lib/companyConfig";
import {
  getDocumentLinkContext,
  getWithholdingRates,
  type DocumentLinkContext,
  type TechnicianCharge,
} from "@/lib/technicianDal";
import type { WithholdingRate } from "@/lib/technicians";
import { PageHeader } from "@/components/PageHeader";
import { backTarget } from "@/lib/backNavigation";
import { Card } from "@/components/Card";
import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { AssignSupplierForm, LinkChargesForm, UnlinkButton } from "./link-form";

/**
 * "Es de un técnico" (Chile): the factura or boleta a technician issued for
 * one or more of their charges becomes the cost of those charges' jobs,
 * instead of being one more general cost next to the charges' own costs
 * (apply_technician_document, 20261101020000). Reached from the document's
 * detail, from a charge ("Vincular documento") and from Conciliar.
 * ?cargos=<id>,<id> preselects charges.
 */
export default async function TechnicianDocumentLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; costDocumentId: string }>;
  searchParams: Promise<{ cargos?: string; volver?: string }>;
}) {
  const { id, costDocumentId } = await params;
  const { cargos, volver } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const documentHref = `/companies/${id}/costs/${costDocumentId}`;
  const header = (
    <PageHeader
      eyebrow="GESTIÓN / COSTOS / DOCUMENTO"
      title="Documento de un técnico"
      subtitle="Una factura o boleta del técnico respalda los cargos que cubre: el costo cuenta en el trabajo y el mes de cada cargo, y el documento no se suma aparte."
      back={backTarget(id, volver, { href: documentHref, label: "Volver al documento" })}
    />
  );

  if (companyConfig(membership.company).country !== "CL") {
    return (
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
        {header}
        <Card>
          <p className="text-[13px] text-[var(--color-ink-2)]">
            Los documentos se vinculan a cargos de técnico solo en empresas de Chile.
          </p>
        </Card>
      </div>
    );
  }

  let context: DocumentLinkContext | null = null;
  let technicians: Personnel[] = [];
  let projects: ProjectWithRelations[] = [];
  let withholdingRates: WithholdingRate[] = [];
  let readFailed = false;
  try {
    [context, technicians, projects, withholdingRates] = await Promise.all([
      getDocumentLinkContext(id, costDocumentId),
      getPersonnel(id),
      getProjects(id),
      getWithholdingRates(),
    ]);
  } catch (error) {
    console.error(error);
    readFailed = true;
  }

  if (readFailed || !context) {
    return (
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
        {header}
        <DataIncompleteBanner details={["el documento y los cargos del técnico"]} />
      </div>
    );
  }

  const { document } = context;
  if (!document) {
    return (
      <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
        {header}
        <Card>
          <p className="text-[13px] text-[var(--color-ink-2)]">
            Solo una factura (FAC-EL, FAC-EE) o una boleta de honorarios (BOL-HE, BOL-TE) importada se vincula a
            cargos de técnico.
          </p>
        </Card>
      </div>
    );
  }

  const documentLabel = document.backing === "boleta" ? "boleta" : "factura";
  const thisPage = `/companies/${id}/costs/${costDocumentId}/technician`;
  const linked = document.linked_charge_ids.length > 0;
  const preselected = cargos ? cargos.split(",").filter(Boolean) : context.suggestedChargeIds;
  const selectionQuery = (ids: string[]) => (ids.length > 0 ? `?cargos=${ids.join(",")}` : "");
  const linkedSum = context.linkedCharges.reduce((sum, charge) => sum + charge.applied_here, 0);
  const toLinkable = (charge: TechnicianCharge) => ({
    id: charge.id,
    charge_date: charge.charge_date,
    project_name: charge.project_name,
    description: charge.description,
    backing: charge.backing,
    cost: charge.net_amount,
    payable: charge.amount,
    paid: charge.paid,
    applied: charge.net_amount - charge.document_pending,
    editHref:
      charge.paid === 0 && !charge.linked_document
        ? `/companies/${id}/projects/${charge.project_id}/technician-charges/${charge.id}/edit?volver=${encodeURIComponent(
            `${thisPage}${selectionQuery(preselected)}`,
          )}`
        : null,
  });

  return (
    <div className="mx-auto flex w-full max-w-[700px] flex-col gap-5">
      {header}

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="caps-label text-[var(--color-muted)]">
              {document.backing === "boleta" ? "Boleta · bruto" : "Factura · neto"}
            </span>
            <Money value={document.net_amount} currency="CLP" className="text-[22px] font-semibold text-[var(--color-ink)]" />
            <span className="font-mono text-[11.5px] text-[var(--color-muted)]">
              {[document.source_document_type, document.document_number].filter(Boolean).join(" ")} ·{" "}
              {document.document_date}
            </span>
            {document.backing === "boleta" && document.liquid_amount !== null ? (
              <span className="text-[12.5px] text-[var(--color-ink-2)]">
                Retención <Money value={document.withholding_amount} currency="CLP" showCurrency={false} /> · Líquido{" "}
                <Money value={document.liquid_amount} currency="CLP" showCurrency={false} />
              </span>
            ) : document.total_amount !== document.net_amount ? (
              <span className="text-[12.5px] text-[var(--color-ink-2)]">
                IVA <Money value={document.total_amount - document.net_amount} currency="CLP" showCurrency={false} /> · Total{" "}
                <Money value={document.total_amount} currency="CLP" showCurrency={false} />
              </span>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-1 text-[12.5px] text-[var(--color-ink-2)]">
            <span>{document.supplier_name ?? "Sin proveedor"}</span>
            {context.technician ? (
              <Link
                href={`/companies/${id}/personnel/${context.technician.id}/account`}
                className="font-medium text-[var(--color-accent-strong)]"
              >
                Técnico: {context.technician.name}
              </Link>
            ) : null}
            {linked ? <Badge variant="positive">Vinculada a cargos de técnico</Badge> : null}
          </div>
        </div>
      </Card>

      {linked ? (
        <div className="flex flex-col gap-2">
          <span className="caps-label text-[var(--color-muted)]">Cargos que cubre</span>
          <Card className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {context.linkedCharges.map((charge) => (
                <li key={charge.id} className="flex flex-wrap items-center gap-2.5 text-[12.5px]">
                  <span className="font-mono text-[var(--color-muted)]">{charge.charge_date}</span>
                  <Link
                    href={`/companies/${id}/projects/${charge.project_id}`}
                    className="flex-1 truncate text-[var(--color-ink)]"
                  >
                    {charge.project_name}
                  </Link>
                  <span className="font-mono tabular-nums text-[var(--color-ink)]">
                    Aplicado <Money value={charge.applied_here} currency="CLP" showCurrency={false} />
                    {charge.applied_here !== charge.net_amount ? (
                      <span className="text-[var(--color-muted)]">
                        {" "}
                        de <Money value={charge.net_amount} currency="CLP" showCurrency={false} />
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            <p data-testid="linked-sum" className="font-mono text-[12px] tabular-nums text-[var(--color-ink-2)]">
              Aplicado <Money value={linkedSum} currency="CLP" showCurrency={false} /> ·{" "}
              {document.backing === "boleta" ? "Bruto" : "Neto"} del documento{" "}
              <Money value={document.net_amount} currency="CLP" showCurrency={false} /> · Diferencia{" "}
              <Money value={document.net_amount - linkedSum} currency="CLP" showCurrency={false} />
            </p>
            <p className="border-t border-[var(--color-hairline-soft)] pt-2 text-[12px] text-[var(--color-ink-2)]">
              Esta {documentLabel} es costo del técnico y respalda esos cargos: lo aplicado cuenta en el trabajo y el
              mes de cada cargo, y no se suma otra vez. No se puede asignar, dividir ni asignar a servicios mientras
              esté vinculada.
            </p>
            <UnlinkButton companyId={id} costDocumentId={costDocumentId} />
          </Card>
        </div>
      ) : !context.technician ? (
        <div className="flex flex-col gap-2">
          <span className="caps-label text-[var(--color-muted)]">¿De qué técnico es?</span>
          <Card className="flex flex-col gap-3">
            <p className="text-[12.5px] text-[var(--color-ink-2)]">
              El proveedor <strong>{document.supplier_name ?? "—"}</strong> todavía no está en la ficha de ningún
              técnico. Elegí el técnico: su RUT queda vinculado y sus facturas y boletas se reconocen solas.
            </p>
            {context.supplierId ? (
              <AssignSupplierForm
                companyId={id}
                costDocumentId={costDocumentId}
                supplierId={context.supplierId}
                technicians={technicians
                  .filter((person) => person.type === "contractor" && person.active)
                  .map((person) => ({ id: person.id, name: person.name }))}
              />
            ) : (
              <p className="text-[12.5px] text-[var(--color-muted)]">Este documento no tiene proveedor.</p>
            )}
          </Card>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="caps-label text-[var(--color-muted)]">
            Cargos pendientes de {context.technician.name}
          </span>
          <Card className="flex flex-col gap-3">
            <LinkChargesForm
              companyId={id}
              costDocumentId={costDocumentId}
              documentBacking={document.backing}
              documentNet={document.net_amount}
              documentLiquid={document.backing === "boleta" ? document.liquid_amount : null}
              documentDate={document.document_date}
              documentLabel={documentLabel}
              assignmentLabel={document.assignment.allocated ? document.assignment.label : null}
              servicesHref={document.assignment.services ? `/companies/${id}/costs/${costDocumentId}/allocate` : null}
              preselected={preselected}
              charges={context.pendingCharges.map(toLinkable)}
              otherBackingCharges={context.otherBackingCharges.map(toLinkable)}
              withholdingRates={withholdingRates}
              technicianId={context.technician.id}
              projects={projects
                .filter((project) => project.status !== "cancelado")
                .map((project) => ({ id: project.id, name: project.name }))}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
