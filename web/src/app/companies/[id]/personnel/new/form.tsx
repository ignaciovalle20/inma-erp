"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createPersonnel, type CreatePersonnelState } from "./actions";

const initialState: CreatePersonnelState = {
  error: null,
  values: { name: "", type: "employee" },
};

export function NewPersonnelForm({ companyId }: { companyId: string }) {
  const createPersonnelWithCompany = createPersonnel.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createPersonnelWithCompany,
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
          htmlFor="type"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Type
        </label>
        <select
          id="type"
          name="type"
          required
          defaultValue={state.values.type}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          <option value="employee">Employee</option>
          <option value="partner">Partner</option>
        </select>
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
          {pending ? "Saving..." : "Create person"}
        </button>
        <Link
          href={`/companies/${companyId}/personnel`}
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
