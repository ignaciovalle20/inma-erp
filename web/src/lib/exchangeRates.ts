import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Story 6.5: Consolidated Chile + Uruguay Result in USD.
 *
 * MonedAPI (`monedapi.ar` v2) is Argentine FX-market-oriented: its
 * `buy`/`sell` for `clp`/`uyu`/`usd` are all ARS-denominated (pesos per
 * unit of the named currency), not USD-denominated -- empirically
 * confirmed before this story was written (see spec Intent: `usd/oficial`
 * returns `buy≈1480`/`sell≈1532`, far too large to be "USD per USD").
 * Converting a source currency to USD therefore requires triangulating
 * through ARS:
 *
 *   usd = (amount_in_source_currency × ars_per_source_currency) / ars_per_usd
 *
 * `fetchArsRate` fetches one leg of that triangulation -- the ARS rate
 * for a single currency -- as the average of `buy`/`sell` (see spec
 * Decisions: a simple midpoint is the most defensible default for a
 * consolidated *report* figure, not an actual currency trade).
 */
const MONEDAPI_BASE_URL = "https://monedapi.ar/api/v2";

type MonedApiCurrency = "clp" | "uyu" | "usd";

type MonedApiResponse = {
  currency: string;
  name: string;
  origin: string;
  buy: number;
  sell: number;
  updatedAt: string;
  lastScrapedAt: string;
  valueType: string;
  change?: unknown;
};

export async function fetchArsRate(
  currency: "CLP" | "UYU" | "USD",
): Promise<{ arsPerUnit: number } | null> {
  const path: MonedApiCurrency = currency.toLowerCase() as MonedApiCurrency;

  try {
    const response = await fetch(`${MONEDAPI_BASE_URL}/${path}/oficial`, {
      // Never cache -- this is always meant to be "the current rate at
      // fetch time"; the snapshot table (not HTTP caching) is what
      // decides whether a stale rate is reused.
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as MonedApiResponse;

    const buy = Number(data.buy);
    const sell = Number(data.sell);

    if (!Number.isFinite(buy) || !Number.isFinite(sell)) {
      return null;
    }

    return { arsPerUnit: (buy + sell) / 2 };
  } catch (error) {
    console.error(error);
    return null;
  }
}

/**
 * Resolves the (currency, period) rate to use for USD conversion,
 * snapshotting on first successful fetch and reusing that snapshot on
 * every later call for the same period -- per spec Decisions.
 *
 * `period` must be the first day of the month (e.g. "2026-09-01"),
 * matching the rest of the reporting engine's convention.
 *
 * - Current period: always attempts a fresh live fetch first (both the
 *   source currency's ARS rate and the ARS/USD rate), upserts a
 *   snapshot on success, and falls back to any existing snapshot for
 *   that period on failure.
 * - Past period: never fetches live -- reads the existing snapshot
 *   only, returning `null` if none exists yet (never guessed/defaulted,
 *   per spec Never).
 *
 * Returns `null` when no rate can be resolved for the period at all --
 * callers must treat that as "pending exchange rate," never as a zero
 * rate.
 */
export async function getOrSnapshotRate(
  currency: "CLP" | "UYU",
  period: string,
): Promise<number | null> {
  const supabase = await createClient();

  const isCurrentPeriod = isCurrentMonth(period);

  if (isCurrentPeriod) {
    const [sourceRate, usdRate] = await Promise.all([
      fetchArsRate(currency),
      fetchArsRate("USD"),
    ]);

    if (sourceRate && usdRate && usdRate.arsPerUnit > 0) {
      const { error } = await supabase
        .from("exchange_rate_snapshots")
        .upsert(
          {
            currency,
            period,
            ars_per_unit: sourceRate.arsPerUnit,
            ars_per_usd: usdRate.arsPerUnit,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "currency,period" },
        );

      if (error) {
        console.error(error);
      }

      return sourceRate.arsPerUnit / usdRate.arsPerUnit;
    }
  }

  // Live fetch failed (or this is a past period): fall back to an
  // existing snapshot for this exact (currency, period), if any.
  const { data, error } = await supabase
    .from("exchange_rate_snapshots")
    .select("ars_per_unit, ars_per_usd")
    .eq("currency", currency)
    .eq("period", period)
    .maybeSingle();

  if (error) {
    console.error(error);
    return null;
  }

  if (!data || !(Number(data.ars_per_usd) > 0)) {
    return null;
  }

  return Number(data.ars_per_unit) / Number(data.ars_per_usd);
}

export type ReportCurrency = "CLP" | "UYU" | "USD";

/**
 * H02 fix: `getOrSnapshotRate` already resolves "USD per unit of CLP or
 * UYU" for a period -- USD per USD is trivially 1, needing no fetch at
 * all. This is the shared building block `getConversionRate` triangulates
 * through, so a document in any of the three currencies converts against
 * a company in any of the three using the exact same underlying rate the
 * consolidated report uses, instead of a second, divergent source.
 */
async function usdPerUnit(
  currency: ReportCurrency,
  period: string,
): Promise<number | null> {
  if (currency === "USD") {
    return 1;
  }
  return getOrSnapshotRate(currency, period);
}

/**
 * Resolves the rate to multiply an amount in `from` by to get the
 * equivalent amount in `to`, for `period` -- `1` when they're the same
 * currency (no lookup at all). Triangulates via each currency's
 * USD-per-unit rate: `from/to`, both in the same USD terms, cancels the
 * USD leg out. Returns `null` -- never a guessed or 1:1 fallback -- when
 * either leg's rate can't be resolved for this period (no live fetch
 * succeeded and no snapshot exists yet); callers must exclude that
 * amount from any total and surface the total as incomplete, per the
 * same "never silently zero" rule `computeConsolidatedResult` already
 * follows for `pendingRateCompanies`.
 */
export async function getConversionRate(
  from: ReportCurrency,
  to: ReportCurrency,
  period: string,
): Promise<number | null> {
  if (from === to) {
    return 1;
  }

  const [fromRate, toRate] = await Promise.all([
    usdPerUnit(from, period),
    usdPerUnit(to, period),
  ]);

  if (fromRate === null || toRate === null || toRate === 0) {
    return null;
  }

  return fromRate / toRate;
}

function isCurrentMonth(period: string): boolean {
  const periodDate = new Date(period);
  const now = new Date();
  return (
    periodDate.getUTCFullYear() === now.getUTCFullYear() &&
    periodDate.getUTCMonth() === now.getUTCMonth()
  );
}
