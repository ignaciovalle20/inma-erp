/**
 * "Eliminar" on an expense (ficha del trabajo, Costos, the document's page):
 * delete_cost_document (20261024020000) removes the document with its lines,
 * allocations, service allocations and receipts. The cost of a technician's
 * charge is never deleted from there -- it is corrected or deleted in the
 * job's Técnicos section, which keeps the technician's payments in step.
 * Pure: the screens pass what they already read.
 */

/** Where a technician's charge is corrected or deleted ("Corregir" in Técnicos). */
export function technicianChargeHref(companyId: string, charge: { id: string; project_id: string }): string {
  return `/companies/${companyId}/projects/${charge.project_id}/technician-charges/${charge.id}/edit`;
}

/**
 * cost_document_id -> its technician's charge page, for the charges at hand.
 * A charge with a purchase document linked has no cost document of its own
 * (the document is deleted like any other: it unlinks first).
 */
export function technicianChargeHrefs(
  companyId: string,
  charges: { id: string; project_id: string; cost_document_id: string | null }[],
): Map<string, string> {
  return new Map(
    charges.flatMap((charge) =>
      charge.cost_document_id ? [[charge.cost_document_id, technicianChargeHref(companyId, charge)] as const] : [],
    ),
  );
}

/** "Descripción · Proveedor · fecha": what the confirmation names the expense by. */
export function costDeletionSummary(parts: {
  description?: string | null;
  supplierName?: string | null;
  date: string;
}): string {
  return [parts.description?.trim() || null, parts.supplierName?.trim() || null, parts.date]
    .filter(Boolean)
    .join(" · ");
}

/** The note for a general cost split across jobs: the whole document goes, not just this job's part. */
export function allocatedShareNote(documentTotal: string): string {
  return `Es un costo general repartido entre trabajos: se elimina el documento completo (${documentTotal}), no solo la parte de este trabajo.`;
}

/** Only a path inside the company is a valid place to go back to after deleting. */
export function safeRedirect(companyId: string, target: string | null | undefined): string | null {
  if (!target) return null;
  return target.startsWith(`/companies/${companyId}/`) && !target.includes("//", 1) ? target : null;
}
