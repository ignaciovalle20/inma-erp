/**
 * A folio stored with its series ("A-13791") and imported without it
 * ("13791") is the same invoice: the generic sales import flags it as a
 * possible duplicate instead of creating it again. All data below is invented.
 */
import { describe, expect, it } from "vitest";
import { findPossibleDuplicate, folioNumber, folioSeries, sameFolio, type ExistingSale } from "@/lib/salesDuplicates";

describe("folio parts", () => {
  it("splits series and number", () => {
    expect(folioNumber("A-13791")).toBe("13791");
    expect(folioNumber("A-013791")).toBe("13791");
    expect(folioNumber("13791")).toBe("13791");
    expect(folioNumber("S/N")).toBeNull();
    expect(folioSeries("a-13791")).toBe("A");
    expect(folioSeries("13791")).toBe("");
  });

  it("a folio with or without its series is the same; two series are not", () => {
    expect(sameFolio("13791", "A-13791")).toBe(true);
    expect(sameFolio("A-13791", "13791")).toBe(true);
    expect(sameFolio("A-13791", "a 13791")).toBe(true);
    expect(sameFolio("B-13791", "A-13791")).toBe(false);
    expect(sameFolio("13791", "13792")).toBe(false);
    expect(sameFolio("", "")).toBe(false);
  });
});

const existing: ExistingSale[] = [
  { client_id: "c1", document_date: "2026-10-10", total_amount: 340.5, document_number: "A-13791" },
  { client_id: "c1", document_date: "2026-07-07", total_amount: 5490, document_number: null },
];

describe("findPossibleDuplicate", () => {
  it("the export's \"13791\" duplicates the stored \"A-13791\" of the same client", () => {
    const row = { clientId: "c1", date: "2026-10-10", total: 340.5, documentNumber: "13791" };
    expect(findPossibleDuplicate(row, existing)?.document_number).toBe("A-13791");
  });

  it("matches the folio even when the date or the amount differ", () => {
    const row = { clientId: "c1", date: "2026-10-11", total: 341, documentNumber: "13791" };
    expect(findPossibleDuplicate(row, existing)?.document_number).toBe("A-13791");
  });

  it("a folio row duplicates a document without folio on the same date and total", () => {
    const row = { clientId: "c1", date: "2026-07-07", total: 5490, documentNumber: "13640" };
    expect(findPossibleDuplicate(row, existing)).toMatchObject({ document_number: null, total_amount: 5490 });
  });

  it("is not a duplicate: another client, another series, another folio on the same day and total", () => {
    expect(findPossibleDuplicate({ clientId: "c2", date: "2026-10-10", total: 340.5, documentNumber: "13791" }, existing)).toBeNull();
    expect(findPossibleDuplicate({ clientId: "c1", date: "2026-10-01", total: 1, documentNumber: "B-13791" }, existing)).toBeNull();
    expect(findPossibleDuplicate({ clientId: "c1", date: "2026-10-10", total: 340.5, documentNumber: "13792" }, existing)).toBeNull();
  });

  it("a row without folio keeps the old rule: same client, date and total", () => {
    expect(findPossibleDuplicate({ clientId: "c1", date: "2026-10-10", total: 340.5, documentNumber: null }, existing)).not.toBeNull();
    expect(findPossibleDuplicate({ clientId: "c1", date: "2026-10-10", total: 340, documentNumber: null }, existing)).toBeNull();
  });
});
