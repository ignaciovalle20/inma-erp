/**
 * Shared vocabulary for the recurring_services template fields added
 * in the servicios-recurrentes redesign (plan-servicios-recurrentes.md,
 * Phase 2/3). Kept in one place so the new/edit forms and their server
 * actions validate against the same lists.
 */

export const SERVICE_TYPES = [
  "ms_licenses",
  "hosting",
  "starlink",
  "server",
  "other",
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  ms_licenses: "Licencias MS",
  hosting: "Hosting",
  starlink: "Starlink",
  server: "Servidor",
  other: "Otro",
};

/**
 * tipo_servicio -> nombre de área de negocio, per
 * plan-servicios-recurrentes.md's "Áreas de negocio" table. Used to
 * suggest (not force) business_area_id when service_type changes --
 * "otro" has no fixed mapping, the user picks manually.
 */
export const SERVICE_TYPE_TO_AREA_NAME: Partial<Record<ServiceType, string>> = {
  ms_licenses: "Microsoft 365",
  hosting: "Hosting",
  starlink: "Starlink",
  server: "Cloud",
};

export const INVOICING_MODES = ["advance", "arrears"] as const;

export type InvoicingMode = (typeof INVOICING_MODES)[number];

export const INVOICING_MODE_LABELS: Record<InvoicingMode, string> = {
  advance: "Anticipado",
  arrears: "Vencido",
};

export const RECURRING_SERVICE_STATUSES = ["active", "paused", "cancelled"] as const;

export type RecurringServiceStatus = (typeof RECURRING_SERVICE_STATUSES)[number];

export const RECURRING_SERVICE_STATUS_LABELS: Record<RecurringServiceStatus, string> = {
  active: "Activo",
  paused: "Pausado",
  cancelled: "Cancelado",
};

export const OCCURRENCE_STATUSES = [
  "pending_invoice",
  "invoiced",
  "pending_collection",
  "collected",
  "void",
] as const;

export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const OCCURRENCE_STATUS_LABELS: Record<OccurrenceStatus, string> = {
  pending_invoice: "Por facturar",
  invoiced: "Facturado",
  pending_collection: "Por cobrar",
  collected: "Cobrado",
  void: "Anulado",
};
