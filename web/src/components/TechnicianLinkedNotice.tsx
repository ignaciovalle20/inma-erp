import { LinkButton } from "@/components/Button";

/**
 * Shown instead of an assignment screen ("Asignar a un trabajo", "Dividir",
 * "Editar asignación", "Asignar a servicios") of a purchase document linked
 * to technician charges: the link decides where it is imputed
 * (link_technician_document, 20261026010000).
 */
export function TechnicianLinkedNotice({ companyId, costDocumentId }: { companyId: string; costDocumentId: string }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-[10px] border border-[var(--color-warning-soft-border)] bg-[var(--color-warning-panel)] p-4 text-[13px] text-[var(--color-warning-ink)]"
    >
      <p>Vinculada a cargos de técnico — desvinculá para cambiar.</p>
      <LinkButton href={`/companies/${companyId}/costs/${costDocumentId}/technician`} variant="secondary" className="w-fit">
        Ver vínculo
      </LinkButton>
    </div>
  );
}
