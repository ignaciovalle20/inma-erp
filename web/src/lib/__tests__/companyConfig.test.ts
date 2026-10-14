/**
 * Every company gets the same features; what differs by country lives in
 * one configuration, read from the company (never `country === "CL"` in a
 * screen). "Uruguay" written out is Uruguay too.
 */
import { describe, expect, it } from "vitest";
import { companyConfig, normalizeCountry, resolveDocumentCurrency } from "@/lib/companyConfig";
import { parseCurrencyCell, parsePaymentStatusCell, resolveRowCurrency } from "@/lib/genericImport";
import { parsePaymentStatusChange } from "@/lib/paymentStatus";
import { cellText } from "@/lib/importFile";

describe("companyConfig", () => {
  it("normalizes the country however it was typed", () => {
    expect(normalizeCountry("Uruguay")).toBe("UY");
    expect(normalizeCountry(" uy ")).toBe("UY");
    expect(normalizeCountry("Chile")).toBe("CL");
    expect(normalizeCountry("Perú")).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });

  it("Chile: CLP only, never asked; Nubox and the generic importer", () => {
    const config = companyConfig({ country: "CL", currency: "CLP" });
    expect(config).toMatchObject({ fixedCurrency: "CLP", vatRate: 0.19, salesImportFormats: ["nubox", "generic"] });
    expect(resolveDocumentCurrency(config, "USD")).toBe("CLP");
  });

  it("Uruguay: USD or UYU chosen; the generic importer", () => {
    const config = companyConfig({ country: "Uruguay", currency: "UYU" });
    expect(config).toMatchObject({ fixedCurrency: null, documentCurrencies: ["USD", "UYU"], vatRate: 0.22 });
    expect(config.salesImportFormats).toEqual(["generic"]);
    expect(resolveDocumentCurrency(config, "usd")).toBe("USD");
    expect(resolveDocumentCurrency(config, "")).toBeNull();
    expect(resolveDocumentCurrency(config, "CLP")).toBeNull();
  });
});

describe("generic importer cells", () => {
  const uy = companyConfig({ country: "UY", currency: "UYU" });
  const cl = companyConfig({ country: "CL", currency: "CLP" });

  it("reads the usual ways of writing a currency and rejects '$' alone", () => {
    expect(parseCurrencyCell("US$")).toEqual({ kind: "ok", value: "USD" });
    expect(parseCurrencyCell("dólares")).toEqual({ kind: "ok", value: "USD" });
    expect(parseCurrencyCell("$U")).toEqual({ kind: "ok", value: "UYU" });
    expect(parseCurrencyCell("")).toEqual({ kind: "empty" });
    expect(parseCurrencyCell("$").kind).toBe("invalid");
  });

  it("applies the company's currency rule to each row", () => {
    expect(resolveRowCurrency(uy, "USD", null)).toEqual({ kind: "ok", value: "USD" });
    expect(resolveRowCurrency(uy, "", "UYU")).toEqual({ kind: "ok", value: "UYU" });
    expect(resolveRowCurrency(uy, "", null).kind).toBe("invalid");
    expect(resolveRowCurrency(uy, "CLP", null).kind).toBe("invalid");
    expect(resolveRowCurrency(cl, "", null)).toEqual({ kind: "ok", value: "CLP" });
    // A Chilean file that says USD is an error, never silently re-labelled CLP.
    expect(resolveRowCurrency(cl, "USD", null).kind).toBe("invalid");
  });

  it("reads a payment status cell as Pagada / Impaga", () => {
    expect(parsePaymentStatusCell("Pagada")).toEqual({ kind: "ok", value: "pagado" });
    expect(parsePaymentStatusCell("sí")).toEqual({ kind: "ok", value: "pagado" });
    expect(parsePaymentStatusCell("Pendiente")).toEqual({ kind: "ok", value: "impago" });
    expect(parsePaymentStatusCell("VENCIDA")).toEqual({ kind: "ok", value: "impago" });
    expect(parsePaymentStatusCell(" ")).toEqual({ kind: "empty" });
    expect(parsePaymentStatusCell("quizás").kind).toBe("invalid");
  });

  it("turns Excel cells into the text the parsers read", () => {
    expect(cellText(new Date(Date.UTC(2026, 8, 15)))).toBe("2026-09-15");
    expect(cellText(1234.5)).toBe("1234.5");
    expect(cellText(1234.567)).toBe("1234.57");
    expect(cellText({ result: 42 })).toBe("42");
    expect(cellText({ richText: [{ text: "Clien" }, { text: "te" }] })).toBe("Cliente");
    expect(cellText(null)).toBe("");
  });
});

describe("parsePaymentStatusChange", () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return data;
  };
  const id = "6f1c1b6e-1111-4c1d-9a2b-123456789abc";

  it("keeps the payment date only when marking paid", () => {
    expect(parsePaymentStatusChange(form([["ids", id], ["status", "pagado"], ["paid_at", "2026-10-01"]]))).toEqual({
      error: null,
      ids: [id],
      status: "pagado",
      paidAt: "2026-10-01",
    });
    expect(parsePaymentStatusChange(form([["ids", id], ["status", "impago"], ["paid_at", "2026-10-01"]]))).toMatchObject({
      status: "impago",
      paidAt: null,
    });
    expect(parsePaymentStatusChange(form([["ids", id], ["status", "pagado"]]))).toMatchObject({ paidAt: null });
  });

  it("refuses no selection, an unknown status or a bad date", () => {
    expect(parsePaymentStatusChange(form([["status", "pagado"]])).error).toMatch(/Seleccioná/);
    expect(parsePaymentStatusChange(form([["ids", "x"], ["status", "pagado"]])).error).toMatch(/Seleccioná/);
    expect(parsePaymentStatusChange(form([["ids", id], ["status", "vencido"]])).error).toMatch(/Pagada o Impaga/);
    expect(parsePaymentStatusChange(form([["ids", id], ["status", "pagado"], ["paid_at", "1/10/26"]])).error).toMatch(
      /fecha/,
    );
  });
});
