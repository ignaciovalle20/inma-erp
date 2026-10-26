import Link from "next/link";
import { Badge } from "@/components/Badge";
import { formatAmount } from "@/components/Money";
import { backingLabel, percentLabel } from "@/lib/technicians";
import type { TechnicianCharge } from "@/lib/technicianDal";
import { DocumentStatusButton } from "./document-status-button";

/**
 * The backing of a charge and its breakdown (Chile): "Factura · neto 100.000 ·
 * IVA 19.000 · total 119.000", "Boleta de honorarios · bruto 442.478 ·
 * retención 15,25% 67.478 · líquido 375.000", or "Sin respaldo". Nothing for
 * a charge without a recorded backing (Uruguay).
 */
export function ChargeBacking({ charge }: { charge: TechnicianCharge }) {
  if (!charge.backing) return null;
  const money = (value: number) => formatAmount(value, "CLP");

  let detail: string | null = null;
  if (charge.backing === "factura") {
    detail = `neto ${money(charge.net_amount)} · IVA ${money(charge.amount - charge.net_amount)} · total ${money(charge.amount)}`;
  } else if (charge.backing === "boleta") {
    const rate = charge.withholding_rate === null ? "" : ` ${percentLabel(charge.withholding_rate)}`;
    detail = `bruto ${money(charge.net_amount)} · retención${rate} ${money(charge.net_amount - charge.amount)} · líquido ${money(charge.amount)}`;
  }

  return (
    <span className="flex flex-col">
      <span className="text-[12px] font-medium text-[var(--color-ink)]">{backingLabel(charge.backing)}</span>
      {detail ? <span className="font-mono text-[11px] text-[var(--color-muted)]">{detail}</span> : null}
    </span>
  );
}

/**
 * The document of a charge. With backing (Chile) it is received by linking
 * the factura or boleta: linked -> the document, pending -> "Vincular
 * documento", sin respaldo -> "No aplica". Without a recorded backing, the
 * old one-click "recibida" toggle.
 */
export function ChargeDocumentCell({
  companyId,
  charge,
  documentName,
}: {
  companyId: string;
  charge: TechnicianCharge;
  /** "Boleta de honorarios" / "Factura": the toggle's wording, for charges without backing. */
  documentName: string;
}) {
  if (!charge.backing) {
    return (
      <DocumentStatusButton
        companyId={companyId}
        projectId={charge.project_id}
        chargeId={charge.id}
        status={charge.document_status}
        documentName={documentName}
      />
    );
  }

  if (charge.backing === "none") {
    return <Badge variant="neutral">No aplica</Badge>;
  }

  if (charge.linked_document) {
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge variant="positive">Recibida</Badge>
        <Link
          href={`/companies/${companyId}/costs/${charge.linked_document.id}/technician`}
          className="font-mono text-[11.5px] font-medium text-[var(--color-accent-strong)]"
        >
          {[charge.linked_document.source_document_type, charge.linked_document.document_number]
            .filter(Boolean)
            .join(" ") || "Documento"}
        </Link>
      </span>
    );
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <Badge variant="warning">Pendiente</Badge>
      <Link
        href={`/companies/${companyId}/projects/${charge.project_id}/technician-charges/${charge.id}/document`}
        className="text-[11.5px] font-medium text-[var(--color-accent-strong)]"
      >
        Vincular documento
      </Link>
    </span>
  );
}
