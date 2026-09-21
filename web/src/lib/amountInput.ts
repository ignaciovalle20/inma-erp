/**
 * Live formatting for money inputs: "." groups thousands and "," is the
 * decimal separator (Chile and Uruguay), while the form submits the plain
 * machine value ("1234567.5") so the server actions keep reading it with
 * Number(). Dots typed by the user are always thousands: a decimal point can
 * not be told apart from a thousands one while somebody is still typing.
 */
export type TypedAmount = {
  /** What the input shows: "1.234.567,5". */
  display: string;
  /** What the form submits: "1234567.5", or "" when there is nothing. */
  machine: string;
};

function groupThousands(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Anything the user typed (digits, "." and ","): the first comma is the
 * decimal separator. Without `grouping` (hours, percentages) there are no
 * thousands to group, so a typed dot is taken as the decimal separator.
 */
export function formatTypedAmount(rawText: string, maxDecimals: number, grouping = true): TypedAmount {
  const raw = !grouping && !rawText.includes(",") ? rawText.replace(".", ",") : rawText;
  const commaAt = raw.indexOf(",");
  const integerRaw = commaAt === -1 ? raw : raw.slice(0, commaAt);
  const decimalRaw = commaAt === -1 ? "" : raw.slice(commaAt + 1);

  let integerDigits = integerRaw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const decimalDigits = decimalRaw.replace(/\D/g, "").slice(0, maxDecimals);
  // Without decimals the comma ends the number: "1234,56" is 1234, not 123456.
  const hasComma = commaAt !== -1 && maxDecimals > 0;

  if (integerDigits === "" && !hasComma) return { display: "", machine: "" };
  if (integerDigits === "") integerDigits = "0";

  return {
    display: (grouping ? groupThousands(integerDigits) : integerDigits) + (hasComma ? `,${decimalDigits}` : ""),
    machine: decimalDigits === "" ? integerDigits : `${integerDigits}.${decimalDigits}`,
  };
}

/** A stored value ("1500000", "1500000.50", 1500000.5) shown the way it is typed. */
export function formatStoredAmount(
  stored: string | number | null | undefined,
  maxDecimals: number,
  grouping = true,
): TypedAmount {
  if (stored === null || stored === undefined || stored === "") return { display: "", machine: "" };
  const [integerPart, decimalPart = ""] = String(stored).trim().split(".");
  const decimals = decimalPart.replace(/0+$/, "");
  return formatTypedAmount(decimals === "" ? integerPart : `${integerPart},${decimals}`, maxDecimals, grouping);
}

/** Digits and the comma are what count when the caret has to survive a reformat. */
const SIGNIFICANT = /[\d,]/;

export function countSignificant(text: string, upTo: number): number {
  let count = 0;
  for (let index = 0; index < Math.min(upTo, text.length); index += 1) {
    if (SIGNIFICANT.test(text[index])) count += 1;
  }
  return count;
}

/** Caret position in `display` that sits after `significant` digits or commas. */
export function caretAfterSignificant(display: string, significant: number): number {
  if (significant <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < display.length; index += 1) {
    if (SIGNIFICANT.test(display[index])) seen += 1;
    if (seen === significant) return index + 1;
  }
  return display.length;
}
