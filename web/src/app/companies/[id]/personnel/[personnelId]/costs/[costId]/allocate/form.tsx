"use client";

import { useActionState, useTransition } from "react";
import type { ProjectWithRelations } from "@/lib/dal";
import { formatAmount } from "@/components/Money";
import { AmountInput } from "@/components/AmountInput";
import { currencyDecimals } from "@/lib/currencies";
import {
  allocateWork,
  removeWorkAllocation,
  type AllocateWorkState,
} from "./actions";

export function WorkAllocationForm({
  companyId,
  personnelId,
  costId,
  projects,
  remainder,
  currency,
}: {
  companyId: string;
  personnelId: string;
  costId: string;
  projects: ProjectWithRelations[];
  remainder: number;
  currency: string;
}) {
  const initialState: AllocateWorkState = {
    error: null,
    success: false,
    values: { project_id: "", amount: "", hours: "" },
  };

  const allocateWorkWithIds = allocateWork.bind(
    null,
    companyId,
    personnelId,
    costId,
  );
  const [state, formAction, pending] = useActionState(
    allocateWorkWithIds,
    initialState,
  );

  if (projects.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        No active projects available to allocate to.
      </p>
    );
  }

  if (remainder <= 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        The full amount is already allocated -- remove an allocation to
        free up room before adding another.
      </p>
    );
  }

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
    >
      <h2 className="text-sm font-medium text-black dark:text-zinc-50">
        Add allocation
      </h2>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="project_id"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Project
        </label>
        <select
          id="project_id"
          name="project_id"
          required
          defaultValue={state.values.project_id}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          <option value="" disabled>
            Select a project
          </option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="amount"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Amount ({currency})
          </label>
          <AmountInput
            id="amount"
            name="amount"
            maxDecimals={currencyDecimals(currency)}
            required
            defaultValue={state.values.amount}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor="hours"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Hours (optional)
          </label>
          <AmountInput
            id="hours"
            name="hours"
            grouping={false}
            defaultValue={state.values.hours}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
      </div>

      <p className="text-xs text-[var(--color-muted)]">
        Up to {formatAmount(remainder, currency)} {currency} remaining.
      </p>

      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.success ? (
        <p className="text-sm text-green-600 dark:text-green-400" role="status">
          Allocation saved.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex h-10 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
      >
        {pending ? "Saving..." : "Add allocation"}
      </button>
    </form>
  );
}

export function RemoveAllocationButton({
  companyId,
  personnelId,
  costId,
  allocationId,
}: {
  companyId: string;
  personnelId: string;
  costId: string;
  allocationId: string;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await removeWorkAllocation(companyId, personnelId, costId, allocationId);
        });
      }}
      className="text-sm text-zinc-500 hover:text-red-600 disabled:opacity-60 dark:text-zinc-500 dark:hover:text-red-400"
    >
      {isPending ? "Removing..." : "Remove"}
    </button>
  );
}
