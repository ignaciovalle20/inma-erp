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

/**
 * Country of a recurring service: always the active company's
 * (companies.country), never asked in a form. The DB trigger
 * recurring_services_apply_company_country (20261002010000) stores it
 * on the service and enforces the same currency rule as below.
 */
export type ServiceCountry = "CL" | "UY";

export function serviceCountry(companyCountry: string | null): ServiceCountry | null {
  const country = (companyCountry ?? "").toUpperCase();
  return country === "CL" || country === "UY" ? country : null;
}

/**
 * Currencies a service of this country may be billed in. Chile: CLP only
 * (no selector). Uruguay: USD or UYU, chosen explicitly. A company with
 * no country keeps the old free choice.
 */
export function currenciesForCountry(country: ServiceCountry | null): string[] {
  if (country === "CL") return ["CLP"];
  if (country === "UY") return ["USD", "UYU"];
  return ["CLP", "UYU", "USD"];
}

export const SERVICE_COUNTRY_LABELS: Record<ServiceCountry, string> = {
  CL: "Chile",
  UY: "Uruguay",
};

/**
 * Resolves the currency to store from what the form sent: forced to CLP
 * for Chile, otherwise it must be one of the country's options. Returns
 * null when the submitted value isn't allowed (or is missing).
 */
export function resolveServiceCurrency(
  country: ServiceCountry | null,
  submitted: unknown,
): string | null {
  if (country === "CL") return "CLP";
  return typeof submitted === "string" && currenciesForCountry(country).includes(submitted)
    ? submitted
    : null;
}

/**
 * The first month managed in the ERP (cycles due before it lived in
 * Planner). Mirrors c_first_month in
 * generate_recurring_service_occurrences_for_month.
 */
export const FIRST_BOARD_MONTH = "2026-09";
