"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  createPersonnelCost,
  type CreatePersonnelCostState,
} from "./actions";

export function NewPersonnelCostForm({
  companyId,
  personnelId,
  defaultCurrency,
}: {
  companyId: string;
  personnelId: string;
  defaultCurrency: string;
}) {
  const initialState: CreatePersonnelCostState = {
    error: null,
    values: { period: "", amount: "", currency: defaultCurrency },
  };

  const createPersonnelCostWithIds = createPersonnelCost.bind(
    null,
    companyId,
    personnelId,
  );
  const [state, formAction, pending] = useActionState(
    createPersonnelCostWithIds,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label
          htmlFor="period"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Period
        </label>
        <input
          id="period"
          name="period"
          type="month"
          required
          defaultValue={state.values.period}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="amount"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Amount
          </label>
          <input
            id="amount"
            name="amount"
            type="number"
            step="0.01"
            required
            defaultValue={state.values.amount}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="currency"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Currency
          </label>
          <select
            id="currency"
            name="currency"
            required
            defaultValue={state.values.currency}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          >
            <option value="CLP">CLP</option>
            <option value="UYU">UYU</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </div>

      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="flex h-10 flex-1 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
        >
          {pending ? "Saving..." : "Record cost"}
        </button>
        <Link
          href={`/companies/${companyId}/personnel/${personnelId}/costs`}
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
