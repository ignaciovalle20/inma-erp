"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { Company } from "@/lib/dal";
import { CURRENCIES } from "@/lib/currencies";
import { updateCompany, type EditCompanyState } from "./actions";

const initialState: EditCompanyState = { error: null };

export function EditCompanyForm({
  companyId,
  company,
}: {
  companyId: string;
  company: Company;
}) {
  const updateCompanyWithId = updateCompany.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    updateCompanyWithId,
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
          defaultValue={company.name}
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
          defaultValue={company.country ?? ""}
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
          defaultValue={company.tax_id ?? ""}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="currency"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Currency
        </label>
        <select
          id="currency"
          name="currency"
          defaultValue={company.currency}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          {CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="active"
          name="active"
          type="checkbox"
          defaultChecked={company.active}
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
          href="/companies"
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
