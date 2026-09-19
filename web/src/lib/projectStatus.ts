import type { BadgeVariant } from "@/components/Badge";
import type { ProjectStatus } from "@/lib/dal";

/**
 * Single source of truth for the job kanban lifecycle (order, label,
 * badge color) -- shared by the projects list, the board and the edit
 * form so the 6 statuses never drift out of sync between screens.
 * docs/cambios-flujo-v2.md 4.1.
 */
export const PROJECT_STATUSES: ProjectStatus[] = [
  "por_cotizar",
  "en_ejecucion",
  "en_espera",
  "finalizado",
  "cerrado",
  "cancelado",
];

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  por_cotizar: "Por cotizar",
  en_ejecucion: "En ejecución",
  en_espera: "En espera",
  finalizado: "Finalizado",
  cerrado: "Cerrado",
  cancelado: "Cancelado",
};

export const PROJECT_STATUS_BADGE_VARIANT: Record<ProjectStatus, BadgeVariant> = {
  por_cotizar: "neutral",
  en_ejecucion: "positive",
  en_espera: "warning",
  finalizado: "outline",
  cerrado: "neutral",
  cancelado: "negative",
};
