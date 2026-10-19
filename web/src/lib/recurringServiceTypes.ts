/**
 * Shared vocabulary for the recurring_services template fields added
 * in the servicios-recurrentes redesign (plan-servicios-recurrentes.md,
 * Phase 2/3). Kept in one place so the new/edit forms and their server
 * actions validate against the same lists.
 */
import { companyConfig, normalizeCountry } from "@/lib/companyConfig";

export const SERVICE_TYPES = [
  "ms_licenses",
  "hosting",
  "domain",
  "starlink",
  "server",
  "other",
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  ms_licenses: "Licencias MS",
  hosting: "Hosting",
  domain: "Dominio",
  starlink: "Starlink",
  server: "Servidor",
  other: "Otro",
};

/**
 * Pricing of a service (20261016010000). The reference amount only
 * projects and pre-fills each period's expected amount; what was billed
 * comes from the invoices allocated to the period. Per unit (MS
 * licenses): unit price x quantity, the quantity editable per period.
 */
export const PRICING_MODES = ["fixed", "per_unit"] as const;

export type PricingMode = (typeof PRICING_MODES)[number];

export const PRICING_MODE_LABELS: Record<PricingMode, string> = {
  fixed: "Monto fijo",
  per_unit: "Por unidad",
};

export type ParsedPricing =
  | {
      ok: true;
      pricing_mode: PricingMode;
      reference_amount: number | null;
      unit_price: number | null;
      default_quantity: number | null;
    }
  | { ok: false; error: string };

function optionalNumber(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : "invalid";
}

/**
 * Reads pricing_mode / reference_amount / unit_price / default_quantity
 * from a service form. A fixed service may have no reference amount (its
 * periods are then expected at 0 until billed); a per-unit one needs both
 * the unit price and the default quantity (the database computes the
 * reference from them).
 */
export function parsePricing(formData: FormData): ParsedPricing {
  const mode = formData.get("pricing_mode");
  const pricingMode: PricingMode = mode === "per_unit" ? "per_unit" : "fixed";

  if (pricingMode === "per_unit") {
    const unitPrice = optionalNumber(formData.get("unit_price"));
    const quantity = optionalNumber(formData.get("default_quantity"));
    if (unitPrice === null || unitPrice === "invalid") {
      return { ok: false, error: "El precio unitario tiene que ser un número." };
    }
    if (quantity === null || quantity === "invalid") {
      return { ok: false, error: "La cantidad tiene que ser un número." };
    }
    return {
      ok: true,
      pricing_mode: pricingMode,
      reference_amount: unitPrice * quantity,
      unit_price: unitPrice,
      default_quantity: quantity,
    };
  }

  const reference = optionalNumber(formData.get("reference_amount"));
  if (reference === "invalid") {
    return { ok: false, error: "El monto referencial tiene que ser un número." };
  }
  return {
    ok: true,
    pricing_mode: pricingMode,
    reference_amount: reference,
    unit_price: null,
    default_quantity: null,
  };
}

/**
 * Next renewal of an annual service (a domain): its due month/day on or
 * after `today` ("YYYY-MM-DD"), or null when it has no due month.
 */
export function nextRenewalDate(
  service: { due_month: number | null; due_day: number | null },
  today: string,
): string | null {
  if (!service.due_month) return null;
  const year = Number(today.slice(0, 4));
  const build = (y: number) => {
    const lastDay = new Date(Date.UTC(y, service.due_month!, 0)).getUTCDate();
    const day = Math.min(service.due_day ?? 1, lastDay);
    return `${y}-${String(service.due_month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  const thisYear = build(year);
  return thisYear >= today ? thisYear : build(year + 1);
}

/** Whole days from `from` to `to` (both "YYYY-MM-DD"). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A domain renewing within this many days is highlighted. */
export const RENEWAL_WARNING_DAYS = 60;

/**
 * Derived state of a period (recurring_service_period_summary.billing_status).
 */
export const PERIOD_BILLING_STATUSES = ["pending_invoice", "invoiced", "paid", "void"] as const;

export type PeriodBillingStatus = (typeof PERIOD_BILLING_STATUSES)[number];

export const PERIOD_BILLING_STATUS_LABELS: Record<PeriodBillingStatus, string> = {
  pending_invoice: "Pendiente de facturar",
  invoiced: "Facturado / se debe",
  paid: "Pagado",
  void: "Anulado",
};

/** The first month of the periods grid (periods are managed from here). */
export const FIRST_PERIOD_MONTH = "2026-09";

/**
 * tipo_servicio -> nombre de área de negocio, per
 * plan-servicios-recurrentes.md's "Áreas de negocio" table. Used to
 * suggest (not force) business_area_id when service_type changes --
 * "otro" has no fixed mapping, the user picks manually.
 */
export const SERVICE_TYPE_TO_AREA_NAME: Partial<Record<ServiceType, string>> = {
  ms_licenses: "Microsoft 365",
  hosting: "Hosting",
  domain: "Hosting",
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
  return normalizeCountry(companyCountry);
}

/**
 * Currencies a service of this country may be billed in: the same rule as
 * every other document of the company (lib/companyConfig.ts). Chile: CLP
 * only (no selector). Uruguay: USD or UYU, chosen explicitly. A company with
 * no country keeps the old free choice.
 */
export function currenciesForCountry(country: ServiceCountry | null): string[] {
  return companyConfig({ country, currency: "" }).documentCurrencies;
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
export const FIRST_BOARD_MONTH = "2026-01";
