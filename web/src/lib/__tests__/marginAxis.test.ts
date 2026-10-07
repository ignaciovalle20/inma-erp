/**
 * The dashboard chart's margin % axis follows the data but stays within
 * -100%..200%: an extreme month (1348%) is drawn at the edge and flagged
 * instead of leaving the chart.
 */
import { describe, expect, it } from "vitest";
import { marginAxis, marginPosition } from "@/lib/marginAxis";

describe("marginAxis", () => {
  it("fits ordinary margins with a readable step and always includes 0", () => {
    expect(marginAxis([12, 35, 41])).toEqual({ min: 0, max: 50 });
    expect(marginAxis([0, 98, 0])).toEqual({ min: 0, max: 100 });
  });

  it("caps an extreme month at 200%", () => {
    expect(marginAxis([0, 30, 1348])).toEqual({ min: 0, max: 200 });
  });

  it("goes below zero for losses, down to -100% at most", () => {
    expect(marginAxis([-35, 20])).toEqual({ min: -40, max: 20 });
    expect(marginAxis([-900, 50])).toEqual({ min: -100, max: 50 });
  });

  it("keeps a non-empty range when there is no data or everything is 0", () => {
    expect(marginAxis([])).toEqual({ min: 0, max: 10 });
    expect(marginAxis([0, 0])).toEqual({ min: 0, max: 10 });
    expect(marginAxis([Number.NaN, Number.POSITIVE_INFINITY])).toEqual({ min: 0, max: 10 });
  });
});

describe("marginPosition", () => {
  const axis = { min: -100, max: 200 };

  it("leaves values inside the axis alone", () => {
    expect(marginPosition(45, axis)).toEqual({ shown: 45, outOfScale: null });
  });

  it("clamps values outside the axis and says on which side", () => {
    expect(marginPosition(1348, axis)).toEqual({ shown: 200, outOfScale: "above" });
    expect(marginPosition(-250, axis)).toEqual({ shown: -100, outOfScale: "below" });
  });
});
