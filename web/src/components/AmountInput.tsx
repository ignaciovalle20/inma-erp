"use client";

import { useLayoutEffect, useRef, useState, type InputHTMLAttributes } from "react";
import {
  caretAfterSignificant,
  countSignificant,
  formatStoredAmount,
  formatTypedAmount,
} from "@/lib/amountInput";

type AmountInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange" | "name" | "min" | "max" | "step"
> & {
  /** Name of the hidden field the form submits (machine format). Leave out when the value only lives in state. */
  name?: string;
  /** Initial value, machine format ("1500000.5"). */
  defaultValue?: string | number | null;
  /** Controlled value, machine format. Pair it with onValueChange. */
  value?: string | number | null;
  /** 0 for CLP (no decimals), 2 for the rest. */
  maxDecimals?: number;
  /** false for hours and percentages: no thousands dots, and a typed "." is a decimal. */
  grouping?: boolean;
  /** Called with the machine value on every change. */
  onValueChange?: (machine: string) => void;
};

const asText = (value: string | number | null | undefined) => (value === null || value === undefined ? "" : String(value));

/**
 * Text input that groups thousands with "." while typing and uses "," for
 * decimals. The visible field has no name: the form submits a hidden input
 * with the plain number ("1500000.5"), which is what the server actions expect.
 *
 * Uncontrolled by default (`defaultValue`); pass `value` + `onValueChange`
 * when the form keeps the amount in state. The parent holds the machine
 * value, so what it computes with is what is submitted.
 */
export function AmountInput({
  name,
  defaultValue,
  value,
  maxDecimals = 2,
  grouping = true,
  onValueChange,
  ...inputProps
}: AmountInputProps) {
  const controlled = value !== undefined;
  const [amount, setAmount] = useState(() =>
    formatStoredAmount(controlled ? value : defaultValue, maxDecimals, grouping),
  );
  const [seenValue, setSeenValue] = useState(asText(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // The parent changed the value on its own (a reset, "pay it all", a
  // recalculation): show it. What the user typed already comes back equal.
  if (controlled && asText(value) !== seenValue) {
    setSeenValue(asText(value));
    if (asText(value) !== amount.machine) {
      setAmount(formatStoredAmount(value, maxDecimals, grouping));
    }
  }

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    inputRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [amount]);

  return (
    <>
      <input
        {...inputProps}
        ref={inputRef}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={amount.display}
        onChange={(event) => {
          const { value: typed, selectionStart } = event.target;
          const next = formatTypedAmount(typed, maxDecimals, grouping);
          pendingCaret.current = caretAfterSignificant(
            next.display,
            countSignificant(typed, selectionStart ?? typed.length),
          );
          setAmount(next);
          onValueChange?.(next.machine);
        }}
      />
      {name ? <input type="hidden" name={name} value={amount.machine} /> : null}
    </>
  );
}
