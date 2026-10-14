/**
 * How a multi-currency summary is shown (components/MoneyBreakdown.tsx):
 * per-currency subtotals, both combined totals, "incompleto" only on the
 * total that misses a rate, and no stray ":" when the line has no label
 * (e2e found "Por facturar:8.007,53 UYU" on the recurring services board).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoneyBreakdown } from "@/components/MoneyBreakdown";
import type { MoneySummary } from "@/lib/multiCurrency";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const summary: MoneySummary = {
  localCurrency: "UYU",
  byCurrency: [
    { currency: "USD", amount: 100, count: 1 },
    { currency: "UYU", amount: 4000, count: 1 },
  ],
  local: 8000,
  usd: 200,
  localComplete: true,
  usdComplete: false,
};

describe("MoneyBreakdown", () => {
  it("inline without a label has no stray colon", () => {
    const out = text(renderToStaticMarkup(createElement(MoneyBreakdown, { summary, variant: "inline", label: "", showSubtotals: false })));
    expect(out).toBe("8.000,00 UYU 200,00 USD incompleto");
    expect(out).not.toContain(":");
  });

  it("inline with a label shows subtotals, the label and both totals", () => {
    const out = text(renderToStaticMarkup(createElement(MoneyBreakdown, { summary, variant: "inline", label: "Total" })));
    expect(out).toBe("100,00 USD 4.000,00 UYU Total: 8.000,00 UYU 200,00 USD incompleto");
  });

  it("lines: one line per currency, then the combined totals", () => {
    const out = text(renderToStaticMarkup(createElement(MoneyBreakdown, { summary, label: "Total combinado", subtotalLabel: "Neto" })));
    expect(out).toBe("Neto USD 100,00 USD Neto UYU 4.000,00 UYU Total combinado 8.000,00 UYU 200,00 USD incompleto");
  });
});
