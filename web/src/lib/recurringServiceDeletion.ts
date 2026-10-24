/**
 * "Eliminar servicio": what keeps a recurring service from being deleted
 * (the database refuses the same, delete_recurring_service in
 * 20261024010000), grouped with where to remove each one. Pure: the data
 * comes from lib/recurringServiceDeletionLoader.ts.
 */

export type DeletionBlockerKind = "sales" | "linked_invoice" | "legacy_document" | "cost" | "pool";

export type DeletionBlocker = { kind: DeletionBlockerKind; label: string };

export type DeletionBlockerGroup = { kind: DeletionBlockerKind; title: string; howTo: string; items: string[] };

const GROUPS: Record<DeletionBlockerKind, { title: string; howTo: string }> = {
  sales: {
    title: "Facturas de venta asignadas a sus ciclos",
    howTo: "Quitá la asignación desde la factura (Ventas → la factura → Asignar) o desde Conciliar.",
  },
  linked_invoice: {
    title: "Ciclos con una factura vinculada",
    howTo: "Desvinculá la factura desde la tarjeta del ciclo, en el historial de abajo.",
  },
  legacy_document: {
    title: "Documentos de venta generados por el servicio",
    howTo: "Anulá o reasigná esos documentos de venta.",
  },
  cost: {
    title: "Facturas de compra asignadas a sus períodos de costo",
    howTo: "Quitá la asignación desde Costos → la factura → Asignar a servicios.",
  },
  pool: {
    title: "Partes del reparto de licencias MS",
    howTo: "Rehacé el reparto de licencias del mes sin este servicio.",
  },
};

/** The blockers grouped by kind, in a fixed order; empty when the service can be deleted. */
export function groupDeletionBlockers(blockers: DeletionBlocker[]): DeletionBlockerGroup[] {
  return (Object.keys(GROUPS) as DeletionBlockerKind[])
    .map((kind) => ({
      kind,
      ...GROUPS[kind],
      items: blockers.filter((blocker) => blocker.kind === kind).map((blocker) => blocker.label),
    }))
    .filter((group) => group.items.length > 0);
}

/** The confirmation question: what goes with the service. */
export function deletionConfirmText(serviceName: string, cycles: number, costPeriods: number): string {
  const parts = [`${cycles} ${cycles === 1 ? "ciclo" : "ciclos"}`];
  if (costPeriods > 0) parts.push(`${costPeriods} ${costPeriods === 1 ? "período de costo" : "períodos de costo"}`);
  return `¿Eliminar "${serviceName}"? Se borran el servicio y sus ${parts.join(" y ")}. No se puede deshacer.`;
}
