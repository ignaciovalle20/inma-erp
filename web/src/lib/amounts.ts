/**
 * Amounts as they arrive in the generic CSV importers (docs/plan-sistema-v3.md,
 * B4). The four places that read them (sales and cost importers, server and
 * preview) used to strip every comma, so "1234,5" became 12345 and
 * "1.234,56" became 1.23456: an amount wrong by ten or a thousand, with no
 * error. One parser, with the convention of the countries that use it (Chile
 * and Uruguay: dot for thousands, comma for decimals), that rejects what it
 * cannot read instead of guessing.
 *
 * Rules:
 *  - Both separators present: the last one is the decimal ("1.234,56" and
 *    "1,234.56" are both 1234.56); the other must group thousands.
 *  - Only dots: several dots group thousands ("1.234.567"); one dot with three
 *    digits after it does too ("1.234" is 1234, the local convention); one dot
 *    with fewer digits is a decimal point ("1234.5").
 *  - Only commas: several commas group thousands ("1,234,567"); one comma is a
 *    decimal ("1234,5"), except "1,234" (a comma with exactly three digits
 *    after 1-3), which is ambiguous and is rejected.
 *  - "$", spaces and a leading "+" or "-" are allowed. Anything else is not
 *    an amount.
 */
export type AmountResult =
  | { kind: "empty" }
  | { kind: "ok"; value: number }
  | { kind: "invalid"; reason: string };

const GROUPED = /^\d{1,3}$/;

/** Every group after the first has exactly three digits. */
function groupsOfThree(integerPart: string, separator: string): boolean {
  const groups = integerPart.split(separator);
  return GROUPED.test(groups[0]) && groups.slice(1).every((group) => /^\d{3}$/.test(group));
}

export function parseAmount(raw: string | null | undefined): AmountResult {
  if (raw === null || raw === undefined) return { kind: "empty" };

  const original = raw.trim();
  if (original === "") return { kind: "empty" };

  let text = original.replace(/[\s$ ]/g, "");
  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  const invalid = (reason: string): AmountResult => ({ kind: "invalid", reason: `"${original}": ${reason}` });

  if (text === "" || !/^[\d.,]+$/.test(text) || !/\d/.test(text)) {
    return invalid("no es un importe (solo dígitos, puntos y comas)");
  }

  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  let normalized: string;

  if (dots > 0 && commas > 0) {
    const decimalSeparator = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    const decimalAt = text.lastIndexOf(decimalSeparator);
    const integerPart = text.slice(0, decimalAt);
    const decimalPart = text.slice(decimalAt + 1);

    // The decimal separator appears once, after every thousands separator.
    if (integerPart.includes(decimalSeparator) || !/^\d+$/.test(decimalPart)) {
      return invalid("mezcla puntos y comas de forma que no se puede leer");
    }
    if (!groupsOfThree(integerPart, thousandsSeparator)) {
      return invalid("los miles no están agrupados de a tres dígitos");
    }
    normalized = `${integerPart.split(thousandsSeparator).join("")}.${decimalPart}`;
  } else if (dots > 1 || commas > 1) {
    const separator = dots > 1 ? "." : ",";
    if (!groupsOfThree(text, separator)) {
      return invalid(`el separador "${separator}" se repite pero no agrupa miles de a tres dígitos`);
    }
    normalized = text.split(separator).join("");
  } else if (dots === 1) {
    const [integerPart, decimalPart] = text.split(".");
    // "1.234" is a thousand in the local convention; "1234.5" is a decimal.
    normalized =
      /^\d{3}$/.test(decimalPart) && GROUPED.test(integerPart) ? `${integerPart}${decimalPart}` : text;
    if (decimalPart === "" || integerPart === "") {
      return invalid("falta un dígito junto al punto");
    }
  } else if (commas === 1) {
    const [integerPart, decimalPart] = text.split(",");
    if (decimalPart === "" || integerPart === "") {
      return invalid("falta un dígito junto a la coma");
    }
    if (/^\d{3}$/.test(decimalPart) && GROUPED.test(integerPart)) {
      return invalid(
        `es ambiguo (¿${integerPart},${decimalPart} con decimales o ${integerPart}${decimalPart}?): escribilo sin separador de miles o con coma decimal`,
      );
    }
    normalized = `${integerPart}.${decimalPart}`;
  } else {
    normalized = text;
  }

  const value = sign * Number(normalized);
  return Number.isFinite(value) ? { kind: "ok", value } : invalid("no es un número");
}

/**
 * The tax cell: empty means no tax (0), but an unreadable value is an error to
 * show, not a silent 0 (an IVA that is really 19% of the net would vanish).
 */
export function parseTaxAmount(
  raw: string | null | undefined,
): { value: number; error: null } | { value: null; error: string } {
  const parsed = parseAmount(raw);
  if (parsed.kind === "empty") return { value: 0, error: null };
  if (parsed.kind === "ok") return { value: parsed.value, error: null };
  return { value: null, error: `IVA inválido ${parsed.reason}` };
}
