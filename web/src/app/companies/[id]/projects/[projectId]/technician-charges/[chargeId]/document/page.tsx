import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import {
  getTechnicianCharges,
  getTechnicianDocuments,
  type TechnicianCharge,
  type TechnicianDocument,
} from "@/lib/technicianDal";
import { backingLabel, linkAmountCheck } from "@/lib/technicians";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";

/**
 * "Vincular documento" from a charge (Chile): the facturas or boletas of the
 * technician's RUTs that are not linked yet, with the charge's backing. Picking
 * one opens the document's link screen with this charge already ticked, where
 * other charges of the same document can be added.
 */
export default async function ChargeDocumentPickerPage({
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

  const projectHref = `/companies/${id}/projects/${projectId}`;
  let charge: TechnicianCharge | null = null;
  let documents: TechnicianDocument[] = [];
  let readFailed = false;
  try {
    const charges = await getTechnicianCharges(id, { projectId });
    charge = charges.find((candidate) => candidate.id === chargeId) ?? null;
    if (charge) documents = await getTechnicianDocuments(id, charge.personnel_id);
  } catch (error) {
    console.error(error);
    readFailed = true;
  }

  if (readFailed) {
    return (
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
        <DataIncompleteBanner details={["el cargo y los documentos del técnico"]} />
        <Link href={projectHref} className="text-[13px] text-[var(--color-muted)]">
          Volver al trabajo
        </Link>
      </div>
    );
  }

  if (!charge) {
    notFound();
  }

  const header = (
    <PageHeader
      eyebrow="GESTIÓN / TRABAJOS / TÉCNICOS"
      title="Vincular documento"
      subtitle={`${charge.personnel_name} · ${charge.project_name} · ${charge.charge_date}`}
      back={{ href: projectHref, label: "Volver al trabajo" }}
    />
  );

  if (charge.backing !== "factura" && charge.backing !== "boleta") {
    return (
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
        {header}
        <Card>
          <p className="text-[13px] text-[var(--color-ink-2)]">
            {charge.backing === "none"
              ? "Este cargo es sin respaldo: no lleva documento."
              : "Este cargo no tiene respaldo registrado. Corregilo y elegí factura o boleta para vincularle el documento."}
          </p>
        </Card>
      </div>
    );
  }

  if (charge.linked_document) {
    redirect(`/companies/${id}/costs/${charge.linked_document.id}/technician`);
  }

  const backing = charge.backing;
  const candidates = documents.filter(
    (document) => document.backing === backing && document.linked_charge_ids.length === 0,
  );

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      {header}
      <Card className="flex flex-wrap items-center justify-between gap-3 text-[12.5px] text-[var(--color-ink-2)]">
        <span>
          Respaldo: <strong>{backingLabel(backing)}</strong> · Costo del trabajo{" "}
          <Money value={charge.net_amount} currency="CLP" showCurrency={false} /> · A pagar{" "}
          <Money value={charge.amount} currency="CLP" showCurrency={false} />
        </span>
        <Link
          href={`/companies/${id}/personnel/${charge.personnel_id}/edit`}
          className="font-medium text-[var(--color-accent-strong)]"
        >
          RUT del técnico
        </Link>
      </Card>

      {candidates.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState
                  message={`No hay ${backing === "boleta" ? "boletas" : "facturas"} sin vincular de los RUT de ${charge.personnel_name}. Importá las compras de Nubox, o agregá el RUT que emitió el documento en la ficha del técnico (también se puede marcar desde el documento: "Es de un técnico").`}
                />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Fecha</Th>
              <Th>Documento</Th>
              <Th>Proveedor</Th>
              <Th align="right">{backing === "boleta" ? "Bruto" : "Neto"}</Th>
              {backing === "boleta" ? <Th align="right">Líquido</Th> : null}
              <Th>Asignación actual</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {candidates.map((document) => (
              <Tr key={document.id}>
                <Td className="font-mono text-[12.5px]">{document.document_date}</Td>
                <Td className="font-mono text-[12.5px]">
                  {[document.source_document_type, document.document_number].filter(Boolean).join(" ")}
                </Td>
                <Td>{document.supplier_name ?? "—"}</Td>
                <Td align="right">
                  <Money value={document.net_amount} currency="CLP" showCurrency={false} />
                  {linkAmountCheck([charge.net_amount], document.net_amount).matches ? (
                    <span className="block text-[11px] text-[var(--color-accent-strong)]">Cuadra con este cargo</span>
                  ) : null}
                </Td>
                {backing === "boleta" ? (
                  <Td align="right">
                    {document.liquid_amount === null ? (
                      "—"
                    ) : (
                      <Money value={document.liquid_amount} currency="CLP" showCurrency={false} />
                    )}
                  </Td>
                ) : null}
                <Td className="text-[12.5px] text-[var(--color-ink-2)]">{document.assignment.label ?? "Sin asignar"}</Td>
                <Td align="right">
                  <Link
                    href={`/companies/${id}/costs/${document.id}/technician?cargos=${charge.id}`}
                    className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                  >
                    Elegir
                  </Link>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
