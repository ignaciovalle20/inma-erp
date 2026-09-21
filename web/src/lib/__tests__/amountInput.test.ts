import { describe, expect, it } from "vitest";
import {
  caretAfterSignificant,
  countSignificant,
  formatStoredAmount,
  formatTypedAmount,
} from "../amountInput";

describe("formatTypedAmount", () => {
  it("groups thousands with dots as digits are typed", () => {
    expect(formatTypedAmount("1", 2)).toEqual({ display: "1", machine: "1" });
    expect(formatTypedAmount("1234", 2)).toEqual({ display: "1.234", machine: "1234" });
    expect(formatTypedAmount("1234567", 2)).toEqual({ display: "1.234.567", machine: "1234567" });
  });

  it("re-reads its own output (typing after a group already there)", () => {
    expect(formatTypedAmount("1.2345", 2)).toEqual({ display: "12.345", machine: "12345" });
    expect(formatTypedAmount("1.234.567", 2).machine).toBe("1234567");
  });

  it("uses the comma as the decimal separator and caps the decimals", () => {
    expect(formatTypedAmount("1234,5", 2)).toEqual({ display: "1.234,5", machine: "1234.5" });
    expect(formatTypedAmount("1234,567", 2)).toEqual({ display: "1.234,56", machine: "1234.56" });
    expect(formatTypedAmount("1234,", 2)).toEqual({ display: "1.234,", machine: "1234" });
    expect(formatTypedAmount("1,2,3", 2)).toEqual({ display: "1,23", machine: "1.23" });
  });

  it("starts a decimal with a zero when the comma comes first", () => {
    expect(formatTypedAmount(",5", 2)).toEqual({ display: "0,5", machine: "0.5" });
  });

  it("has no decimals for a currency without them", () => {
    expect(formatTypedAmount("1234,56", 0)).toEqual({ display: "1.234", machine: "1234" });
  });

  it("drops leading zeros and anything that is not a digit", () => {
    expect(formatTypedAmount("007", 2)).toEqual({ display: "7", machine: "7" });
    expect(formatTypedAmount("0", 2)).toEqual({ display: "0", machine: "0" });
    expect(formatTypedAmount("$ 1a2b", 2)).toEqual({ display: "12", machine: "12" });
    expect(formatTypedAmount("", 2)).toEqual({ display: "", machine: "" });
    expect(formatTypedAmount("abc", 2)).toEqual({ display: "", machine: "" });
  });
});

describe("formatStoredAmount", () => {
  it("shows a stored number the way it is typed", () => {
    expect(formatStoredAmount("1500000", 2)).toEqual({ display: "1.500.000", machine: "1500000" });
    expect(formatStoredAmount(1500000.5, 2)).toEqual({ display: "1.500.000,5", machine: "1500000.5" });
    expect(formatStoredAmount("1500000.50", 2)).toEqual({ display: "1.500.000,5", machine: "1500000.5" });
    expect(formatStoredAmount("1500000.00", 2)).toEqual({ display: "1.500.000", machine: "1500000" });
  });

  it("rounds nothing: a decimal for a no-decimals currency is dropped", () => {
    expect(formatStoredAmount("1500000.75", 0)).toEqual({ display: "1.500.000", machine: "1500000" });
  });

  it("is empty for no value", () => {
    expect(formatStoredAmount(null, 2)).toEqual({ display: "", machine: "" });
    expect(formatStoredAmount(undefined, 2)).toEqual({ display: "", machine: "" });
    expect(formatStoredAmount("", 2)).toEqual({ display: "", machine: "" });
  });
});

describe("caret", () => {
  it("keeps the caret after the same digit when a dot appears", () => {
    // "1234|" typed -> "1.234|"
    const typed = "1234";
    const { display } = formatTypedAmount(typed, 2);
    expect(caretAfterSignificant(display, countSignificant(typed, 4))).toBe(5);
  });

  it("keeps the caret in the middle when editing there", () => {
    // "12|345" -> user types "9" -> "129|345" -> "129.345" with the caret after the 9
    const typed = "129345";
    const { display } = formatTypedAmount(typed, 2);
    expect(display).toBe("129.345");
    expect(caretAfterSignificant(display, countSignificant(typed, 3))).toBe(3);
  });

  it("puts the caret at the start when nothing significant is before it", () => {
    expect(caretAfterSignificant("1.234", 0)).toBe(0);
  });
});

describe("without thousands (hours, percentages)", () => {
  it("takes a typed dot as the decimal separator and never groups", () => {
    expect(formatTypedAmount("7.5", 2, false)).toEqual({ display: "7,5", machine: "7.5" });
    expect(formatTypedAmount("7,5", 2, false)).toEqual({ display: "7,5", machine: "7.5" });
    expect(formatTypedAmount("1234", 2, false)).toEqual({ display: "1234", machine: "1234" });
  });

  it("does not turn a second dot into digits once there is a comma", () => {
    expect(formatTypedAmount("7,5.", 2, false)).toEqual({ display: "7,5", machine: "7.5" });
  });

  it("shows a stored value without groups", () => {
    expect(formatStoredAmount("33.33", 2, false)).toEqual({ display: "33,33", machine: "33.33" });
    expect(formatStoredAmount("1000", 2, false)).toEqual({ display: "1000", machine: "1000" });
  });
});
