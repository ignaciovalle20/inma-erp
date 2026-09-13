"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { Client, RecurringService } from "@/lib/dal";
import {
  updateRecurringService,
  type EditRecurringServiceState,
} from "./actions";

const initialState: EditRecurringServiceState = { error: null };

export function EditRecurringServiceForm({
  companyId,
  clients,
  recurringService,
}: {
  companyId: string;
  clients: Client[];
  recurringService: RecurringService;
}) {
  const updateRecurringServiceWithIds = updateRecurringService.bind(
    null,
    companyId,
    recurringService.id,
  );
  const [state, formAction, pending] = useActionState(
    updateRecurringServiceWithIds,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label
          htmlFor="client_id"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Client
        </label>
        <select
          id="client_id"
          name="client_id"
          required
          defaultValue={recurringService.client_id}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="name"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Service name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={recurringService.name}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="price"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Price
          </label>
          <input
            id="price"
            name="price"
            type="number"
            step="0.01"
            required
            defaultValue={recurringService.price}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="expected_cost"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Expected cost
          </label>
          <input
            id="expected_cost"
            name="expected_cost"
            type="number"
            step="0.01"
            defaultValue={recurringService.expected_cost}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
      </div>

      <div className="flex gap-3">
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
            defaultValue={recurringService.currency}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          >
            <option value="CLP">CLP</option>
            <option value="UYU">UYU</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="periodicity"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Periodicity
          </label>
          <select
            id="periodicity"
            name="periodicity"
            required
            defaultValue={recurringService.periodicity}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          >
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </select>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="start_date"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Start date
          </label>
          <input
            id="start_date"
            name="start_date"
            type="date"
            required
            defaultValue={recurringService.start_date}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="end_date"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            End date
          </label>
          <input
            id="end_date"
            name="end_date"
            type="date"
            defaultValue={recurringService.end_date ?? ""}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={recurringService.active}
          className="h-4 w-4 rounded border-black/[.08] dark:border-white/[.145]"
        />
        <label
          htmlFor="active"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Active
        </label>
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
          {pending ? "Saving..." : "Save changes"}
        </button>
        <Link
          href={`/companies/${companyId}/recurring-services`}
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
