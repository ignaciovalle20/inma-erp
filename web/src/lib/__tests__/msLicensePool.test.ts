/**
 * A cost document that is the Microsoft licenses invoice of a month that
 * already has an MS licenses pool must not count twice: the form warns and
 * the document is "cubierto por pool" (docs/verificacion-contable-2026-10-04.md,
 * P08 -> point 5). Same supplier as the pool, or the licenses area, and the
 * same month -- but never a document attributed to a job or area outside
 * the licenses area (a supplier can bill other things too: excluding a real
 * cost would overstate the result).
 */
import { describe, expect, it } from "vitest";
import { findCoveringPool } from "@/lib/msLicensePool";

const pools = [
  { id: "pool-sep", period: "2026-09-01", supplierId: "microsoft", supplierName: "Microsoft" },
  { id: "pool-oct", period: "2026-10-01", supplierId: null, supplierName: null },
];
const msAreas = ["area-ms"];

describe("findCoveringPool", () => {
  it("same supplier as the pool and same month", () => {
    expect(findCoveringPool({ date: "2026-09-30", supplierId: "microsoft", areaIds: [] }, pools, msAreas)?.id).toBe("pool-sep");
    expect(findCoveringPool({ date: "2026-09-30", supplierId: "microsoft", areaIds: ["area-ms"] }, pools, msAreas)?.id).toBe("pool-sep");
  });

  it("the licenses area and same month, whatever the supplier", () => {
    expect(findCoveringPool({ date: "2026-10-03", supplierId: null, areaIds: ["area-ms"] }, pools, msAreas)?.id).toBe("pool-oct");
    expect(findCoveringPool({ date: "2026-09-03", supplierId: "other", areaIds: ["area-ms"] }, pools, msAreas)?.id).toBe("pool-sep");
  });

  it("never a document attributed outside the licenses area, even from the pool's supplier", () => {
    expect(findCoveringPool({ date: "2026-09-03", supplierId: "microsoft", areaIds: ["area-it"] }, pools, msAreas)).toBeNull();
    expect(findCoveringPool({ date: "2026-09-03", supplierId: "other", areaIds: ["area-x", "area-ms"] }, pools, msAreas)).toBeNull();
  });

  it("nothing for another month, another supplier and area, or no date", () => {
    expect(findCoveringPool({ date: "2026-11-01", supplierId: "microsoft", areaIds: ["area-ms"] }, pools, msAreas)).toBeNull();
    expect(findCoveringPool({ date: "2026-09-10", supplierId: "other", areaIds: [] }, pools, msAreas)).toBeNull();
    // The October pool has no supplier: only the area can match it.
    expect(findCoveringPool({ date: "2026-10-10", supplierId: "microsoft", areaIds: [] }, pools, msAreas)).toBeNull();
    expect(findCoveringPool({ date: "", supplierId: "microsoft", areaIds: [] }, pools, msAreas)).toBeNull();
  });
});
