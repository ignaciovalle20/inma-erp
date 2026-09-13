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

function isCurrentMonth(period: string): boolean {
  const periodDate = new Date(period);
  const now = new Date();
  return (
    periodDate.getUTCFullYear() === now.getUTCFullYear() &&
    periodDate.getUTCMonth() === now.getUTCMonth()
  );
}
