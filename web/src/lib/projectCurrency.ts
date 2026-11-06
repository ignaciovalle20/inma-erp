import { resolveDocumentCurrency, type CompanyConfig } from "@/lib/companyConfig";

/**
 * The currency of a job (projects.currency), by the company's configuration
 * (lib/companyConfig.ts), never by a hard-coded country:
 *  - one currency (Chile: CLP): no selector, that one is used;
 *  - two (Uruguay: USD or UYU): a selector, the local currency by default.
 * The quote and the cost budget of the job are in it; reports convert from
 * it (lib/reporting.ts), never add it 1:1 with the local currency.
 */
export type ProjectCurrencyChoice = {
  /** The currencies offered; one = no selector. */
  currencies: string[];
  /** Preselected: the job's own when editing, else the local one. */
  defaultCurrency: string;
  showSelector: boolean;
};

export function projectCurrencyChoice(config: CompanyConfig, current?: string | null): ProjectCurrencyChoice {
  const currencies = [...config.documentCurrencies];
  // A job saved before the company's configuration narrowed keeps its own
  // currency visible, so editing it never silently changes it.
  if (current && !currencies.includes(current)) currencies.push(current);
  const defaultCurrency =
    current && currencies.includes(current)
      ? current
      : currencies.includes(config.localCurrency)
        ? config.localCurrency
        : currencies[0];
  return { currencies, defaultCurrency, showSelector: currencies.length > 1 };
}

/**
 * The currency to store from the form: the fixed one when the company has
 * only one, else one of its currencies. Null = missing or not allowed.
 */
export function resolveProjectCurrency(config: CompanyConfig, submitted: unknown): string | null {
  return resolveDocumentCurrency(config, submitted);
}

export function projectCurrencyNotAllowedMessage(config: CompanyConfig): string {
  return `Elegí la moneda del trabajo: ${config.documentCurrencies.join(" o ")}.`;
}

export const PROJECT_CURRENCY_LOCKED_MESSAGE =
  "No se puede cambiar la moneda: el trabajo ya tiene ventas, costos o cargos registrados. Sus montos y lo facturado se calculan en la moneda actual.";

/**
 * The message for a database error about the job's currency (trigger
 * projects_set_currency), or null when the error is about something else.
 */
export function projectCurrencyDbErrorMessage(
  error: { message?: string } | null | undefined,
  config: CompanyConfig,
): string | null {
  const message = error?.message ?? "";
  if (message.includes("project_currency_locked")) return PROJECT_CURRENCY_LOCKED_MESSAGE;
  if (message.includes("project_currency_not_allowed")) return projectCurrencyNotAllowedMessage(config);
  return null;
}
