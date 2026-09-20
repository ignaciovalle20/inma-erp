/**
 * Rules of the external technicians (docs/plan-sistema-v3.md, F1). Pure, so
 * they can be tested without a database. The database is the source of truth
 * for the cost of a charge (technician_charge_net, same formula as
 * chargeCost below) and for every cross-row check; what lives here is what the
 * screens need to preview, group and explain.
 */

/** IVA of the country: Uruguay 22 %, Chile 19 %. Uruguay is told apart by its currency, like the quick entry. */
export function defaultVatRate(currency: string): number {
  return currency === "UYU" ? 0.22 : 0.19;
}

export function vatRateLabel(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

const toCents = (value: number) => Math.round(value * 100);
const fromCents = (cents: number) => cents / 100;

/** Whole units in CLP (no fractional pesos), cents elsewhere. */
function roundForCurrency(value: number, currency: string): number {
  const factor = currency === "CLP" ? 1 : 100;
  return Math.round(value * factor) / factor;
}

export type ChargeCost = {
  /** What the job is charged: the amount without IVA when the amount includes it. */
  net: number;
  tax: number;
  /** What INMA owes the technician. */
  total: number;
};

/**
 * The cost of a charge. When the amount already includes IVA the job carries
 * the net and the IVA is not a cost; otherwise the whole amount is the cost.
 */
export function chargeCost(input: {
  amount: number;
  vatIncluded: boolean;
  vatRate: number;
  currency: string;
}): ChargeCost {
  const { amount, vatIncluded, vatRate, currency } = input;
  const net = vatIncluded ? roundForCurrency(amount / (1 + vatRate), currency) : amount;
  return { net, tax: fromCents(toCents(amount) - toCents(net)), total: amount };
}

// ---------------------------------------------------------------------
// Charges, payments and balances
// ---------------------------------------------------------------------

export type PaymentStatus = "sin_pagar" | "parcial" | "pagado";

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  sin_pagar: "Sin pagar",
  parcial: "Pago parcial",
  pagado: "Pagado",
};

export function paymentStatus(amount: number, paid: number): PaymentStatus {
  if (toCents(paid) <= 0) return "sin_pagar";
  return toCents(paid) >= toCents(amount) ? "pagado" : "parcial";
}

export type DocumentStatus = "pendiente" | "recibida";

export function documentLabel(paymentDocument: string | null): string {
  if (paymentDocument === "boleta_honorarios") return "Boleta de honorarios";
  if (paymentDocument === "factura") return "Factura";
  return "Documento";
}

type ChargeAmounts = {
  id: string;
  amount: number;
  paid: number;
};

/** What is still owed on a charge. */
export function outstanding(charge: Pick<ChargeAmounts, "amount" | "paid">): number {
  return fromCents(Math.max(0, toCents(charge.amount) - toCents(charge.paid)));
}

export type OpenCharge = { id: string; charge_date: string; outstanding: number };

export type Application = { chargeId: string; amount: number };

/**
 * Splits a payment over the charges still owed, oldest first (the way a
 * cuenta corriente is normally paid). What does not fit is returned as
 * `unapplied`: a payment can only cover charges that exist.
 */
export function distributeOldestFirst(
  charges: OpenCharge[],
  amount: number,
): { applications: Application[]; unapplied: number } {
  let remaining = toCents(amount);
  const applications: Application[] = [];

  const ordered = [...charges].sort(
    (a, b) => a.charge_date.localeCompare(b.charge_date) || a.id.localeCompare(b.id),
  );

  for (const charge of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, toCents(charge.outstanding));
    if (take <= 0) continue;
    applications.push({ chargeId: charge.id, amount: fromCents(take) });
    remaining -= take;
  }

  return { applications, unapplied: fromCents(Math.max(0, remaining)) };
}

/**
 * Checks a payment before it goes to the database: positive amounts, each
 * charge once, nothing above what a charge still owes, and the applications
 * adding up to the payment. Returns the message to show, or null when fine.
 */
export function validatePayment(input: {
  amount: number;
  applications: Application[];
  outstandingByCharge: Map<string, number>;
}): string | null {
  const { amount, applications, outstandingByCharge } = input;

  if (!Number.isFinite(amount) || toCents(amount) <= 0) {
    return "El monto del pago debe ser mayor a cero.";
  }
  if (applications.length === 0) {
    return "Aplicá el pago a al menos un cargo.";
  }

  const seen = new Set<string>();
  let applied = 0;
  for (const application of applications) {
    if (seen.has(application.chargeId)) return "Un cargo aparece dos veces en el pago.";
    seen.add(application.chargeId);

    if (!Number.isFinite(application.amount) || toCents(application.amount) <= 0) {
      return "Cada monto aplicado debe ser mayor a cero.";
    }
    const owed = outstandingByCharge.get(application.chargeId);
    if (owed === undefined) return "El pago incluye un cargo que no es de este técnico.";
    if (toCents(application.amount) > toCents(owed)) {
      return "No se puede aplicar a un cargo más de lo que falta pagarle.";
    }
    applied += toCents(application.amount);
  }

  if (applied !== toCents(amount)) {
    return "Lo aplicado a los cargos tiene que sumar exactamente el monto del pago.";
  }
  return null;
}

export type ChargeSummaryInput = {
  id: string;
  project_id: string;
  personnel_id: string;
  amount: number;
  paid: number;
  document_status: DocumentStatus;
};

export type TechnicianSummary = {
  chargeCount: number;
  charged: number;
  paid: number;
  /** What INMA still owes: charged - paid. */
  balance: number;
  /** Charges whose boleta/factura has not arrived yet. */
  pendingDocuments: number;
};

/** The saldo of each technician, from their charges (paid = sum of applications). */
export function summarizeByTechnician(charges: ChargeSummaryInput[]): Map<string, TechnicianSummary> {
  const cents = new Map<string, { count: number; charged: number; paid: number; pending: number }>();

  for (const charge of charges) {
    const entry = cents.get(charge.personnel_id) ?? { count: 0, charged: 0, paid: 0, pending: 0 };
    entry.count += 1;
    entry.charged += toCents(charge.amount);
    entry.paid += toCents(charge.paid);
    if (charge.document_status === "pendiente") entry.pending += 1;
    cents.set(charge.personnel_id, entry);
  }

  return new Map(
    Array.from(cents, ([personnelId, entry]) => [
      personnelId,
      {
        chargeCount: entry.count,
        charged: fromCents(entry.charged),
        paid: fromCents(entry.paid),
        balance: fromCents(entry.charged - entry.paid),
        pendingDocuments: entry.pending,
      },
    ]),
  );
}

export type ProjectTechnicianSummary = {
  chargeCount: number;
  charged: number;
  paid: number;
  payment: PaymentStatus;
  /** "recibida" only when every charge of the job has its document. */
  document: DocumentStatus;
};

/** The board-card indicators: how a job stands with its technicians. */
export function summarizeByProject(charges: ChargeSummaryInput[]): Map<string, ProjectTechnicianSummary> {
  const cents = new Map<string, { count: number; charged: number; paid: number; pending: boolean }>();

  for (const charge of charges) {
    const entry = cents.get(charge.project_id) ?? { count: 0, charged: 0, paid: 0, pending: false };
    entry.count += 1;
    entry.charged += toCents(charge.amount);
    entry.paid += toCents(charge.paid);
    if (charge.document_status === "pendiente") entry.pending = true;
    cents.set(charge.project_id, entry);
  }

  return new Map(
    Array.from(cents, ([projectId, entry]) => [
      projectId,
      {
        chargeCount: entry.count,
        charged: fromCents(entry.charged),
        paid: fromCents(entry.paid),
        payment: paymentStatus(fromCents(entry.charged), fromCents(entry.paid)),
        document: entry.pending ? "pendiente" : "recibida",
      },
    ]),
  );
}

// ---------------------------------------------------------------------
// The technician's ficha
// ---------------------------------------------------------------------

export const RATE_FIELDS = [
  { key: "visit", label: "Visita" },
  { key: "hour", label: "Hora" },
  { key: "network_point", label: "Punto de red" },
] as const;

export type RateKey = (typeof RATE_FIELDS)[number]["key"];
export type DefaultRates = Partial<Record<RateKey, number>>;

export const PAYMENT_DOCUMENTS = [
  { value: "boleta_honorarios", label: "Boleta de honorarios" },
  { value: "factura", label: "Factura" },
] as const;

export type TechnicianProfile = {
  tax_id: string | null;
  payment_document: string | null;
  default_rates: DefaultRates;
  payment_details: string | null;
};

/** The ficha fields of the personnel forms, as the strings the inputs hold. */
export type TechnicianFormValues = {
  tax_id: string;
  payment_document: string;
  rate_visit: string;
  rate_hour: string;
  rate_network_point: string;
  payment_details: string;
};

export const EMPTY_TECHNICIAN_FORM: TechnicianFormValues = {
  tax_id: "",
  payment_document: "",
  rate_visit: "",
  rate_hour: "",
  rate_network_point: "",
  payment_details: "",
};

/** What was typed, to show it again if the form comes back with an error. */
export function readTechnicianFormValues(get: (name: string) => string): TechnicianFormValues {
  return {
    tax_id: get("tax_id"),
    payment_document: get("payment_document"),
    rate_visit: get("rate_visit"),
    rate_hour: get("rate_hour"),
    rate_network_point: get("rate_network_point"),
    payment_details: get("payment_details"),
  };
}

/** The stored ficha as form values, for the edit form. */
export function technicianFormValuesOf(profile: TechnicianProfile): TechnicianFormValues {
  return {
    tax_id: profile.tax_id ?? "",
    payment_document: profile.payment_document ?? "",
    rate_visit: profile.default_rates.visit?.toString() ?? "",
    rate_hour: profile.default_rates.hour?.toString() ?? "",
    rate_network_point: profile.default_rates.network_point?.toString() ?? "",
    payment_details: profile.payment_details ?? "",
  };
}

/** Rates as they are stored: only the ones filled in, as numbers. Anything else in the JSON is ignored. */
export function readDefaultRates(stored: unknown): DefaultRates {
  const rates: DefaultRates = {};
  if (typeof stored !== "object" || stored === null) return rates;

  for (const { key } of RATE_FIELDS) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) rates[key] = value;
  }
  return rates;
}

/**
 * Reads the ficha fields of the personnel forms. Empty fields are simply not
 * set; a rate that is not a positive number is an error to show, not a
 * silent 0.
 */
export function parseTechnicianProfile(
  get: (name: string) => string,
): { ok: true; value: TechnicianProfile } | { ok: false; error: string } {
  const rates: DefaultRates = {};

  for (const { key, label } of RATE_FIELDS) {
    const raw = get(`rate_${key}`).trim();
    if (raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, error: `La tarifa de ${label.toLowerCase()} debe ser un número mayor a cero.` };
    }
    rates[key] = value;
  }

  const document = get("payment_document").trim();
  if (document !== "" && !PAYMENT_DOCUMENTS.some((option) => option.value === document)) {
    return { ok: false, error: "Elegí un documento de pago válido." };
  }

  return {
    ok: true,
    value: {
      tax_id: get("tax_id").trim() || null,
      payment_document: document || null,
      default_rates: rates,
      payment_details: get("payment_details").trim() || null,
    },
  };
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/** Turns what the database says into what the person should read. Anything unknown is shown as is. */
export function describeTechnicianError(message: string): string {
  const rules: Array<[RegExp, string]> = [
    [
      /technician_\w+.*(does not exist|schema cache)|Could not find the function public\.\w*technician/i,
      "Falta aplicar la migración de técnicos externos en la base de datos.",
    ],
    [
      /already has payments applied/i,
      "Este cargo ya tiene pagos aplicados: primero borrá esos pagos en la cuenta corriente del técnico.",
    ],
    [/split across jobs/i, "El costo de este cargo se prorrateó entre trabajos: deshacé el prorrateo primero."],
    [/cannot exceed its amount/i, "Un pago no puede aplicarse a un cargo por más de lo que falta pagarle."],
    [/must add up/i, "Lo aplicado a los cargos tiene que sumar exactamente el monto del pago."],
    [/same technician/i, "Un pago solo puede aplicarse a cargos del mismo técnico."],
    [
      /External technicians have no monthly cost/i,
      "Los técnicos externos no tienen costo mensual: cargá sus cobros por trabajo.",
    ],
    [
      /already has monthly costs/i,
      "Esta persona ya tiene costos mensuales y no puede pasar a técnico externo.",
    ],
    [/already has charges/i, "Este técnico ya tiene cargos: no se puede cambiar su tipo."],
    [/Authentication required/i, "Tu sesión venció: volvé a iniciar sesión."],
  ];

  for (const [pattern, text] of rules) {
    if (pattern.test(message)) return text;
  }
  return message;
}
