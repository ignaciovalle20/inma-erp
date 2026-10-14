import { CURRENCIES } from "@/lib/currencies";

/**
 * What a company can do, read from its own configuration (country and
 * currency) instead of `country === "CL"` checks spread over the screens:
 * every company gets the same features, and the few intended differences
 * live here.
 *
 *  - Chile: every document in CLP, never asked. Sales also come from the
 *    Nubox export (a Chilean invoicing system).
 *  - Uruguay: each document in USD or UYU, chosen explicitly.
 *  - A company with no known country keeps the free choice of the three.
 */
export type CountryCode = "CL" | "UY";

export type SalesImportFormat = "nubox" | "generic";

export type CompanyConfig = {
  country: CountryCode | null;
  /** The company's own currency: every report is also expressed in it. */
  localCurrency: string;
  /** Currencies a sale, cost or recurring service may be in. */
  documentCurrencies: string[];
  /** The only currency allowed, when there is just one (no selector shown). */
  fixedCurrency: string | null;
  vatRate: number | null;
  timeZone: string;
  /** Sales importers offered, first one is the default tab. */
  salesImportFormats: SalesImportFormat[];
};

type CountrySettings = Omit<CompanyConfig, "country" | "localCurrency" | "fixedCurrency">;

const COUNTRY_SETTINGS: Record<CountryCode, CountrySettings> = {
  CL: {
    documentCurrencies: ["CLP"],
    vatRate: 0.19,
    timeZone: "America/Santiago",
    salesImportFormats: ["nubox", "generic"],
  },
  UY: {
    documentCurrencies: ["USD", "UYU"],
    vatRate: 0.22,
    timeZone: "America/Montevideo",
    salesImportFormats: ["generic"],
  },
};

const COUNTRY_ALIASES: Record<string, CountryCode> = {
  CL: "CL",
  CHILE: "CL",
  UY: "UY",
  URUGUAY: "UY",
};

/** "UY", "uy", "Uruguay" -> "UY"; anything unknown -> null (never guessed). */
export function normalizeCountry(raw: string | null | undefined): CountryCode | null {
  const key = (raw ?? "")
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase();
  return COUNTRY_ALIASES[key] ?? null;
}

export function companyConfig(company: {
  country: string | null | undefined;
  currency: string;
}): CompanyConfig {
  const country = normalizeCountry(company.country);
  const settings: CountrySettings = country
    ? COUNTRY_SETTINGS[country]
    : {
        documentCurrencies: [...CURRENCIES],
        vatRate: null,
        timeZone: "America/Montevideo",
        salesImportFormats: ["generic"],
      };

  return {
    country,
    localCurrency: company.currency,
    ...settings,
    fixedCurrency: settings.documentCurrencies.length === 1 ? settings.documentCurrencies[0] : null,
  };
}

/**
 * The currency to store from what a form or a file sent: the fixed one when
 * the company has only one, otherwise one of its allowed currencies. Null
 * when the value is missing or not allowed.
 */
export function resolveDocumentCurrency(config: CompanyConfig, submitted: unknown): string | null {
  if (config.fixedCurrency) return config.fixedCurrency;
  const value = typeof submitted === "string" ? submitted.trim().toUpperCase() : "";
  return config.documentCurrencies.includes(value) ? value : null;
}
