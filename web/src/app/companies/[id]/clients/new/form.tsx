"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createClient, type CreateClientState } from "./actions";

const initialState: CreateClientState = {
  error: null,
  warning: null,
  values: { name: "", tax_id: "", country: "", notes: "" },
};

export function NewClientForm({ companyId }: { companyId: string }) {
  const createClientWithCompany = createClient.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createClientWithCompany,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label
          htmlFor="name"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          defaultValue={state.values.name}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="tax_id"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Tax ID
        </label>
        <input
          id="tax_id"
          name="tax_id"
          type="text"
          defaultValue={state.values.tax_id}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="country"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Country
        </label>
        <input
          id="country"
          name="country"
          type="text"
          defaultValue={state.values.country}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="notes"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={state.values.notes}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      {state.warning ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded border border-amber-400/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <p>
            This name closely matches an existing client in this company:{" "}
            {state.warning.matches.join(", ")}. You can save anyway if this is
            a different client.
          </p>
          <input type="hidden" name="confirmed" value="true" />
          <input
            type="hidden"
            name="confirmedName"
            value={state.warning.checkedName}
          />
        </div>
      ) : null}

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
          {pending
            ? "Saving..."
            : state.warning
              ? "Save anyway"
              : "Create client"}
        </button>
        <Link
          href={`/companies/${companyId}/clients`}
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
