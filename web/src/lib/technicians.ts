import { parseAmount } from "./amounts";
import { companyConfig } from "./companyConfig";
import { taxIdForStorage } from "./rut";

/**
 * Rules of the external technicians (docs/plan-sistema-v3.md, F1). Pure, so
 * they can be tested without a database. The database is the source of truth
 * for the cost of a charge (technician_charge_net, same formula as
 * chargeCost below) and for every cross-row check; what lives here is what the
 * screens need to preview, group and explain.
 */

/**
 * An amount typed by a person (a rate, what a technician charges), read with
 * the local convention: dot for thousands, comma for decimals. A number input
 * hands "25.000" over as 25, a thousand times too small and with no error;
 * this reads it as 25000 and rejects what it cannot tell ("25,000").
 */
export type PositiveAmount =
  | { kind: "empty" }
  | { kind: "ok"; value: number }
  | { kind: "invalid"; reason: string };

export function parsePositiveAmount(raw: string): PositiveAmount {
  const parsed = parseAmount(raw);
  if (parsed.kind === "ok" && parsed.value <= 0) {
    return { kind: "invalid", reason: `"${raw.trim()}": tiene que ser mayor a cero` };
  }
  return parsed;
}

/**
 * IVA of the company's country (lib/companyConfig.ts): Uruguay 22 %, Chile
 * 19 %. It used to be told apart by the currency, so a Uruguayan company's
 * USD charge got Chile's 19 %. Without a known country, 19 % as before.
 */
export function defaultVatRate(company: { country: string | null; currency: string }): number {
  return companyConfig(company).vatRate ?? (company.currency === "UYU" ? 0.22 : 0.19);
}

export function vatRateLabel(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

/** A rate as a percentage with up to 2 decimals and a decimal comma: 0.1525 -> "15,25%". */
export function percentLabel(rate: number): string {
  return `${String(Number((rate * 100).toFixed(2))).replace(".", ",")}%`;
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
// Backing of a charge (Chile): factura, boleta de honorarios or none
// ---------------------------------------------------------------------

/**
 * What backs a charge in a Chilean company. The usual one of a technician
 * (personnel.default_backing) pre-fills each new charge; each charge keeps its
 * own. Uruguay does not record it (null).
 */
export type Backing = "factura" | "boleta" | "none";

export const BACKING_OPTIONS: { value: Backing; label: string }[] = [
  { value: "factura", label: "Factura" },
  { value: "boleta", label: "Boleta de honorarios" },
  { value: "none", label: "Sin respaldo" },
];

export function backingLabel(backing: Backing | null | undefined): string {
  return BACKING_OPTIONS.find((option) => option.value === backing)?.label ?? "—";
}

export function isBacking(value: unknown): value is Backing {
  return value === "factura" || value === "boleta" || value === "none";
}

/** How the amount of a charge was typed: one amount, factura net or total, boleta líquido or bruto. */
export type EnteredAs = "amount" | "net" | "total" | "liquid" | "gross";

export const ENTRY_MODES: Record<Backing, { value: EnteredAs; label: string }[]> = {
  none: [{ value: "amount", label: "Monto" }],
  factura: [
    { value: "net", label: "Neto" },
    { value: "total", label: "Total con IVA" },
  ],
  boleta: [
    { value: "liquid", label: "Líquido" },
    { value: "gross", label: "Bruto" },
  ],
};

export function defaultEntryMode(backing: Backing): EnteredAs {
  return ENTRY_MODES[backing][0].value;
}

export function isEntryModeOf(backing: Backing, enteredAs: unknown): enteredAs is EnteredAs {
  return ENTRY_MODES[backing].some((mode) => mode.value === enteredAs);
}

/** IVA of a factura in Chile. */
export const FACTURA_VAT_RATE = 0.19;

export type WithholdingRate = { year: number; rate: number };

/**
 * The retención of a boleta de honorarios for a date: the rate of its year,
 * or of the latest earlier year in the table (boleta_withholding_rates, same
 * rule as boleta_withholding_rate in SQL). Null when the table has no year
 * that early.
 */
export function withholdingRateFor(rates: WithholdingRate[], date: string): number | null {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) return null;
  const applicable = rates.filter((row) => row.year <= year).sort((a, b) => b.year - a.year)[0];
  return applicable ? applicable.rate : null;
}

/** Rates in hundredths of a percent: 15,25 % is 1525. The table has at most 4 decimals. */
const BASIS_POINTS = 10000;

/** round(num / den) for positive whole numbers, halves up: what round() does on numeric. */
function roundDiv(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export type BackedChargeAmounts = {
  /** What INMA owes the technician: total with IVA (factura), líquido (boleta) or the amount. */
  payable: number;
  /** The cost of the job: net (factura), bruto (boleta) or the amount. */
  cost: number;
  /** IVA of a factura; 0 otherwise. */
  vat: number;
  /** Retención of a boleta (the SII's, never owed to the technician); 0 otherwise. */
  withholding: number;
  withholdingRate: number | null;
};

/**
 * The amounts of a charge with backing, in whole pesos (Chile). Same formulas
 * as technician_backing_amounts in SQL, which is what is saved:
 *   factura: from the net, IVA = round(net × 19 %) and total = net + IVA;
 *            from the total, net = round(total / 1,19).
 *   boleta:  from the líquido, bruto = round(líquido / (1 − tasa));
 *            from the bruto, retención = round(bruto × tasa), líquido = bruto − retención.
 *   none:    cost = what is paid = the amount.
 * Null when the amount is not usable (not positive, or a boleta without a rate).
 */
export function backedChargeAmounts(input: {
  backing: Backing;
  enteredAs: EnteredAs;
  value: number;
  withholdingRate: number | null;
}): BackedChargeAmounts | null {
  const { backing, enteredAs, value, withholdingRate } = input;
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return null;

  // In whole numbers, like numeric in the database: in floating point
  // 100 × 0,145 is 14,4999…, which rounded to 14 where the database stores 15.
  const vatPoints = Math.round(FACTURA_VAT_RATE * BASIS_POINTS);
  let payable: number;
  let cost: number;
  if (backing === "none") {
    payable = value;
    cost = value;
  } else if (backing === "factura") {
    if (enteredAs === "net") {
      cost = value;
      payable = value + roundDiv(value * vatPoints, BASIS_POINTS);
    } else {
      payable = value;
      cost = roundDiv(value * BASIS_POINTS, BASIS_POINTS + vatPoints);
    }
  } else {
    if (withholdingRate === null) return null;
    const ratePoints = Math.round(withholdingRate * BASIS_POINTS);
    if (enteredAs === "liquid") {
      payable = value;
      cost = roundDiv(value * BASIS_POINTS, BASIS_POINTS - ratePoints);
    } else {
      cost = value;
      payable = value - roundDiv(value * ratePoints, BASIS_POINTS);
    }
  }
  if (cost <= 0 || payable <= 0) return null;

  return {
    payable,
    cost,
    vat: backing === "factura" ? payable - cost : 0,
    withholding: backing === "boleta" ? cost - payable : 0,
    withholdingRate: backing === "boleta" ? withholdingRate : null,
  };
}

/** A whole-peso amount typed with or without thousands dots ("375.000", "375000"). */
export function parseWholePesos(raw: string): PositiveAmount {
  const parsed = parsePositiveAmount(raw);
  if (parsed.kind === "ok" && !Number.isInteger(parsed.value)) {
    return { kind: "invalid", reason: `"${raw.trim()}": va en pesos enteros, sin decimales` };
  }
  return parsed;
}

/** The value the form starts from when correcting a charge typed in `enteredAs`. */
export function enteredValueOf(charge: {
  backing: Backing;
  entered_as: EnteredAs | null;
  amount: number;
  net_amount: number;
}): { enteredAs: EnteredAs; value: number } {
  const enteredAs = charge.entered_as && isEntryModeOf(charge.backing, charge.entered_as)
    ? charge.entered_as
    : defaultEntryMode(charge.backing);
  const value = enteredAs === "net" || enteredAs === "gross" ? charge.net_amount : charge.amount;
  return { enteredAs, value };
}

/** Which backing an imported purchase document is: FAC-EL/FAC-EE a factura, BOL-HE/BOL-TE a boleta. */
export function backingOfSourceType(sourceDocumentType: string | null | undefined): "factura" | "boleta" | null {
  const code = (sourceDocumentType ?? "").trim().toUpperCase();
  if (code === "FAC-EL" || code === "FAC-EE") return "factura";
  if (code === "BOL-HE" || code === "BOL-TE") return "boleta";
  return null;
}

/**
 * Do the costs of some charges cover the document's net (Neto + Exento of a
 * factura, bruto of a boleta)? 1 peso of rounding per charge, the rule of
 * link_technician_document. difference = net − sum.
 */
export function linkAmountCheck(costs: number[], net: number): { sum: number; difference: number; matches: boolean } {
  const sum = costs.reduce((total, cost) => total + cost, 0);
  const difference = net - sum;
  return { sum, difference, matches: costs.length > 0 && Math.abs(difference) <= costs.length };
}

export type BoletaLinkCheck = {
  /** Bruto of the boleta against the charges' costs (their bruto): what decides the link. */
  gross: { sum: number; difference: number; matches: boolean };
  /** Líquido of the boleta against what is paid on the charges (their líquido). */
  liquid: { sum: number; difference: number; matches: boolean };
  /**
   * The boleta's bruto is what the charges pay, not what they cost: bruto and
   * líquido look crossed, which usually means this is not the charges' boleta.
   */
  looksCrossed: boolean;
};

/**
 * A boleta against some charges, always like with like: bruto with bruto and
 * líquido with líquido. INMA pays the technician the líquido and the SII the
 * retención; the job's cost is the bruto.
 */
export function boletaLinkCheck(
  charges: { cost: number; payable: number }[],
  boleta: { gross: number; liquid: number },
): BoletaLinkCheck {
  const gross = linkAmountCheck(charges.map((charge) => charge.cost), boleta.gross);
  const liquid = linkAmountCheck(charges.map((charge) => charge.payable), boleta.liquid);
  return {
    gross,
    liquid,
    looksCrossed: !gross.matches && linkAmountCheck(charges.map((charge) => charge.payable), boleta.gross).matches,
  };
}

/** At most this many pending charges are combined when looking for a suggestion. */
export const MAX_SUGGESTION_CANDIDATES = 15;

/**
 * The one set of charges whose costs add up to the document's net (same
 * tolerance as linking), or null when there is none, more than one, or too
 * many candidates to search them all. Never guesses between two equally good
 * combinations: that is for a person to decide.
 */
export function uniqueChargeCombination(
  charges: { id: string; cost: number }[],
  net: number,
  maxCandidates: number = MAX_SUGGESTION_CANDIDATES,
): string[] | null {
  const candidates = charges.filter((charge) => charge.cost > 0 && charge.cost <= net + charges.length);
  if (candidates.length === 0 || candidates.length > maxCandidates) return null;

  let found: string[] | null = null;
  const total = 1 << candidates.length;
  for (let mask = 1; mask < total; mask++) {
    const picked: { id: string; cost: number }[] = [];
    for (let index = 0; index < candidates.length; index++) {
      if (mask & (1 << index)) picked.push(candidates[index]);
    }
    if (!linkAmountCheck(picked.map((charge) => charge.cost), net).matches) continue;
    if (found) return null;
    found = picked.map((charge) => charge.id);
  }
  return found;
}

export type SuggestionDocument = {
  id: string;
  personnelId: string;
  backing: "factura" | "boleta";
  documentDate: string;
  net: number;
};

export type SuggestionCharge = {
  id: string;
  personnelId: string;
  backing: Backing | null;
  chargeDate: string;
  cost: number;
};

/**
 * Proposes, for each document without a link, the one combination of its
 * technician's pending charges (same backing, dated on or before the
 * document) whose costs add up to its net. Oldest document first; a charge
 * proposed for one document is not offered to the next. `claimed` are charges
 * already in a pending suggestion.
 */
export function proposeTechnicianSuggestions(
  documents: SuggestionDocument[],
  charges: SuggestionCharge[],
  claimed: Iterable<string> = [],
): { documentId: string; personnelId: string; chargeIds: string[] }[] {
  const taken = new Set(claimed);
  const proposals: { documentId: string; personnelId: string; chargeIds: string[] }[] = [];
  const ordered = [...documents].sort(
    (a, b) => a.documentDate.localeCompare(b.documentDate) || a.id.localeCompare(b.id),
  );

  for (const document of ordered) {
    const candidates = charges
      .filter(
        (charge) =>
          charge.personnelId === document.personnelId &&
          charge.backing === document.backing &&
          charge.chargeDate <= document.documentDate &&
          !taken.has(charge.id),
      )
      .map((charge) => ({ id: charge.id, cost: charge.cost }));
    const combination = uniqueChargeCombination(candidates, document.net);
    if (!combination) continue;
    combination.forEach((id) => taken.add(id));
    proposals.push({ documentId: document.id, personnelId: document.personnelId, chargeIds: combination });
  }
  return proposals;
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

/**
 * The boleta / factura of a charge: pendiente until it arrives (in Chile, until
 * it is linked), recibida, or no_aplica for a charge without backing, which
 * never counts as pending.
 */
export type DocumentStatus = "pendiente" | "recibida" | "no_aplica";

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
  /**
   * "pendiente" while any charge of the job waits for its document; otherwise
   * "recibida", or "no_aplica" when no charge of the job has backing. A charge
   * without backing ("no aplica") never holds the job back.
   */
  document: DocumentStatus;
};

/** The board-card indicators: how a job stands with its technicians. */
export function summarizeByProject(charges: ChargeSummaryInput[]): Map<string, ProjectTechnicianSummary> {
  const cents = new Map<
    string,
    { count: number; charged: number; paid: number; pending: boolean; withDocument: boolean }
  >();

  for (const charge of charges) {
    const entry = cents.get(charge.project_id) ?? {
      count: 0,
      charged: 0,
      paid: 0,
      pending: false,
      withDocument: false,
    };
    entry.count += 1;
    entry.charged += toCents(charge.amount);
    entry.paid += toCents(charge.paid);
    if (charge.document_status === "pendiente") entry.pending = true;
    if (charge.document_status !== "no_aplica") entry.withDocument = true;
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
        document: entry.pending ? "pendiente" : entry.withDocument ? "recibida" : "no_aplica",
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
  /** The document they issue (Uruguay's ficha; in Chile it follows default_backing). */
  payment_document: string | null;
  /** Chile: "Respaldo habitual". Only set when the form has it. */
  default_backing?: Backing;
  default_rates: DefaultRates;
  payment_details: string | null;
};

/** The ficha fields of the personnel forms, as the strings the inputs hold. */
export type TechnicianFormValues = {
  tax_id: string;
  payment_document: string;
  default_backing: string;
  rate_visit: string;
  rate_hour: string;
  rate_network_point: string;
  payment_details: string;
};

export const EMPTY_TECHNICIAN_FORM: TechnicianFormValues = {
  tax_id: "",
  payment_document: "",
  default_backing: "none",
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
    default_backing: get("default_backing") || "none",
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
    default_backing: profile.default_backing ?? "none",
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
    const parsed = parsePositiveAmount(get(`rate_${key}`));
    if (parsed.kind === "empty") continue;
    if (parsed.kind === "invalid") {
      return { ok: false, error: `Tarifa de ${label.toLowerCase()} inválida ${parsed.reason}` };
    }
    rates[key] = parsed.value;
  }

  // Chile's ficha has "Respaldo habitual" instead of "Documento que emite";
  // the old column follows it, so both always say the same.
  const backing = get("default_backing").trim();
  if (backing !== "") {
    if (!isBacking(backing)) return { ok: false, error: "Elegí un respaldo habitual válido." };
    return {
      ok: true,
      value: {
        tax_id: taxIdForStorage(get("tax_id")),
        payment_document: backing === "factura" ? "factura" : backing === "boleta" ? "boleta_honorarios" : null,
        default_backing: backing,
        default_rates: rates,
        payment_details: get("payment_details").trim() || null,
      },
    };
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

/**
 * What the database says while the technicians migration is not applied: its
 * tables and functions are missing, and so are the new columns of `personnel`
 * (and the 'contractor' value of its type check), which is the first thing
 * anyone meets when creating or listing a technician.
 */
const MISSING_MIGRATION =
  /technician_\w+.*(does not exist|schema cache)|Could not find the function public\.\w*technician|column of 'personnel' in the schema cache|column personnel\.\w+ does not exist|personnel_type_check/i;

/** Turns what the database says into what the person should read. Anything unknown is shown as is. */
export function describeTechnicianError(message: string): string {
  const rules: Array<[RegExp, string]> = [
    [MISSING_MIGRATION, "Falta aplicar la migración de técnicos externos en la base de datos."],
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
    [/duplicate key value.*technician_suppliers_supplier_id/i, "Ese proveedor ya está vinculado a un técnico."],
  ];

  for (const [pattern, text] of rules) {
    if (pattern.test(message)) return text;
  }
  // The link RPCs prefix their own Spanish messages with a code for the app.
  return message.replace(LINK_ERROR_CODE, "");
}

/** The codes link_technician_document puts in front of its messages. */
export type LinkErrorCode =
  | "NOT_ELIGIBLE"
  | "NO_TECHNICIAN"
  | "CHARGES"
  | "AMOUNT_MISMATCH"
  | "ALLOCATED"
  | "ALREADY_LINKED"
  | "SERVICES";

const LINK_ERROR_CODE = /^(NOT_ELIGIBLE|NO_TECHNICIAN|CHARGES|AMOUNT_MISMATCH|ALLOCATED|ALREADY_LINKED|SERVICES): /;

export function linkErrorCode(message: string): LinkErrorCode | null {
  const match = LINK_ERROR_CODE.exec(message);
  return match ? (match[1] as LinkErrorCode) : null;
}
