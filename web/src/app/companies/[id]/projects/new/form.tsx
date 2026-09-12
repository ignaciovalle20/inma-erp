"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { Client, BusinessArea } from "@/lib/dal";
import { createProject, type CreateProjectState } from "./actions";

const initialState: CreateProjectState = {
  error: null,
  values: {
    name: "",
    client_id: "",
    business_area_id: "",
    start_date: "",
    end_date: "",
    budget: "",
    responsible: "",
  },
};

export function NewProjectForm({
  companyId,
  clients,
  areas,
}: {
  companyId: string;
  clients: Client[];
  areas: BusinessArea[];
}) {
  const createProjectWithCompany = createProject.bind(null, companyId);
  const [state, formAction, pending] = useActionState(
    createProjectWithCompany,
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
          htmlFor="client_id"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Client
        </label>
        <select
          id="client_id"
          name="client_id"
          required
          defaultValue={state.values.client_id}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          <option value="" disabled>
            Select a client
          </option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="business_area_id"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Business area
        </label>
        <select
          id="business_area_id"
          name="business_area_id"
          required
          defaultValue={state.values.business_area_id}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        >
          <option value="" disabled>
            Select a business area
          </option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
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
            defaultValue={state.values.start_date}
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
            defaultValue={state.values.end_date}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="budget"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Budget
        </label>
        <input
          id="budget"
          name="budget"
          type="number"
          step="0.01"
          defaultValue={state.values.budget}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="responsible"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Responsible
        </label>
        <input
          id="responsible"
          name="responsible"
          type="text"
          defaultValue={state.values.responsible}
          className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
        />
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
          {pending ? "Saving..." : "Create project"}
        </button>
        <Link
          href={`/companies/${companyId}/projects`}
          className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
