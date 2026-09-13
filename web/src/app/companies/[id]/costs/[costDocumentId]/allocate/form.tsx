"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type {
  BusinessArea,
  Client,
  CostAllocationMethod,
  CostAllocationTargetType,
  CostAllocationWithTargetName,
  CostDocument,
  ProjectWithRelations,
} from "@/lib/dal";
import {
  setCostAllocations,
  type AllocationRowInput,
  type SetCostAllocationsState,
} from "./actions";

const TARGET_TYPE_OPTIONS: { value: CostAllocationTargetType; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "client", label: "Client" },
  { value: "business_area", label: "Business area" },
];

const METHOD_OPTIONS: { value: CostAllocationMethod; label: string }[] = [
  { value: "percentage", label: "Percentage" },
  { value: "fixed_amount", label: "Fixed amount" },
];

function emptyRow(): AllocationRowInput {
  return { target_type: "", target_id: "", method: "percentage", value: "" };
}

export function CostAllocationForm({
  companyId,
  document,
  allocations,
  projects,
  clients,
  businessAreas,
}: {
  companyId: string;
  document: CostDocument;
  allocations: CostAllocationWithTargetName[];
  projects: ProjectWithRelations[];
  clients: Client[];
  businessAreas: BusinessArea[];
}) {
  const setCostAllocationsWithIds = setCostAllocations.bind(
    null,
    companyId,
    document.id,
  );

  const initialRows: AllocationRowInput[] =
    allocations.length > 0
      ? allocations.map((allocation) => ({
          target_type: allocation.target_type,
          target_id: allocation.target_id,
          method: allocation.method,
          value: String(
            allocation.method === "percentage"
              ? allocation.percentage
              : allocation.amount,
          ),
        }))
      : [emptyRow(), emptyRow()];

  const initialState: SetCostAllocationsState = {
    error: null,
    success: false,
    values: { rows: initialRows },
  };

  const [state, formAction, pending] = useActionState(
    setCostAllocationsWithIds,
    initialState,
  );

  const [rows, setRows] = useState<AllocationRowInput[]>(
    state.values.rows.length > 0 ? state.values.rows : [emptyRow(), emptyRow()],
  );

  function updateRow(index: number, patch: Partial<AllocationRowInput>) {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, ...patch };
        // Swapping target type invalidates whichever target was picked
        // under the previous type.
        if (patch.target_type !== undefined && patch.target_type !== row.target_type) {
          next.target_id = "";
        }
        return next;
      }),
    );
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(index: number) {
    setRows((prev) =>
      prev.length > 2 ? prev.filter((_, i) => i !== index) : prev,
    );
  }

  function pickerOptions(targetType: CostAllocationTargetType | "") {
    if (targetType === "project") {
      return projects.map((project) => ({ id: project.id, name: project.name }));
    }
    if (targetType === "client") {
      return clients.map((client) => ({ id: client.id, name: client.name }));
    }
    if (targetType === "business_area") {
      return businessAreas.map((area) => ({ id: area.id, name: area.name }));
    }
    return [];
  }

  const runningTotal = rows.reduce((sum, row) => {
    const value = Number(row.value);
    if (!Number.isFinite(value)) return sum;
    const share =
      row.method === "percentage"
        ? (document.total_amount * value) / 100
        : value;
    return sum + share;
  }, 0);

  const totalMatches = Math.abs(runningTotal - document.total_amount) <= 0.01;
  const hasIncompleteRow = rows.some(
    (row) =>
      !row.target_type ||
      !row.target_id ||
      row.value.trim() === "" ||
      !Number.isFinite(Number(row.value)),
  );
  const hasEnoughRows = rows.length >= 2;
  const canSubmit = totalMatches && !hasIncompleteRow && hasEnoughRows;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1 rounded-md border border-black/[.08] p-4 text-sm dark:border-white/[.145]">
        <span className="text-zinc-500 dark:text-zinc-500">
          Document total ({document.currency})
        </span>
        <span className="text-lg font-semibold text-black dark:text-zinc-50">
          {document.total_amount.toFixed(2)}
        </span>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Allocation targets
          </span>
          <button
            type="button"
            onClick={addRow}
            className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            Add target
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-md border border-black/[.08] p-3 dark:border-white/[.145]"
            >
              <div className="flex gap-2">
                <div className="flex flex-1 flex-col gap-1">
                  <label className="text-xs text-zinc-500 dark:text-zinc-500">
                    Target type
                  </label>
                  <select
                    name="target_type"
                    value={row.target_type}
                    onChange={(event) =>
                      updateRow(index, {
                        target_type: event.target
                          .value as CostAllocationTargetType,
                      })
                    }
                    className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
                  >
                    <option value="" disabled>
                      Select type
                    </option>
                    {TARGET_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <label className="text-xs text-zinc-500 dark:text-zinc-500">
                    Target
                  </label>
                  <select
                    name="target_id"
                    value={row.target_id}
                    disabled={!row.target_type}
                    onChange={(event) =>
                      updateRow(index, { target_id: event.target.value })
                    }
                    className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 disabled:opacity-40 dark:border-white/[.145] dark:text-zinc-50"
                  >
                    <option value="" disabled>
                      Select target
                    </option>
                    {pickerOptions(row.target_type).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1">
                  <label className="text-xs text-zinc-500 dark:text-zinc-500">
                    Method
                  </label>
                  <select
                    name="method"
                    value={row.method}
                    onChange={(event) =>
                      updateRow(index, {
                        method: event.target.value as CostAllocationMethod,
                      })
                    }
                    className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
                  >
                    {METHOD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <label className="text-xs text-zinc-500 dark:text-zinc-500">
                    {row.method === "percentage" ? "Percentage" : "Amount"}
                  </label>
                  <input
                    name="value"
                    type="number"
                    step="0.01"
                    value={row.value}
                    onChange={(event) =>
                      updateRow(index, { value: event.target.value })
                    }
                    className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  disabled={rows.length <= 2}
                  className="h-9 px-2 text-sm text-zinc-500 hover:text-red-600 disabled:opacity-40 dark:text-zinc-500 dark:hover:text-red-400"
                  aria-label="Remove target"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>

        <div
          className={`flex items-center justify-between rounded-md border p-3 text-sm ${
            totalMatches
              ? "border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-400"
              : "border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-400"
          }`}
        >
          <span>Running total</span>
          <span className="font-medium">
            {runningTotal.toFixed(2)} / {document.total_amount.toFixed(2)}
          </span>
        </div>

        {!hasEnoughRows ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            At least 2 targets are required.
          </p>
        ) : null}

        {state.error ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {state.error}
          </p>
        ) : null}

        {state.success ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">
            Allocations saved.
          </p>
        ) : null}

        <div className="mt-2 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || !canSubmit}
            className="flex h-10 flex-1 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
          >
            {pending ? "Saving..." : "Save allocations"}
          </button>
          <Link
            href={`/companies/${companyId}/costs`}
            className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Back
          </Link>
        </div>
      </form>
    </div>
  );
}
