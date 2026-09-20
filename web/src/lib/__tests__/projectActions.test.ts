/**
 * Error paths of the kanban Server Actions: they must hand the real
 * failure message back to the UI (never fail silently, never a generic
 * "algo salió mal"), so the card can show it and roll back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type QueryResult = { data?: unknown; error: { message: string; code?: string } | null };

const state: { result: QueryResult } = { result: { data: [], error: null } };
const revalidatePath = vi.fn();

// Every query-builder method returns the same chainable, awaitable object
// -- enough for .update().eq().eq().select() and .insert(). The client
// itself is a separate, non-thenable object: an awaitable one would be
// unwrapped by `await createClient()`.
function chain() {
  const builder: Record<string, unknown> = {};
  for (const method of ["update", "insert", "eq", "select"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (value: QueryResult) => unknown) => resolve(state.result);
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: () => chain() }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

import { updateProjectStatus } from "@/app/companies/[id]/projects/board/actions";
import { addProjectQuote } from "@/app/companies/[id]/projects/[projectId]/actions";

function statusForm(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

beforeEach(() => {
  state.result = { data: [{ id: "project-1" }], error: null };
  revalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("updateProjectStatus", () => {
  it("returns no error and revalidates when the update succeeds", async () => {
    const result = await updateProjectStatus(
      "company-1",
      statusForm({ project_id: "project-1", status: "finalizado" }),
    );

    expect(result).toEqual({ error: null });
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/projects/board");
  });

  it("returns the real database error message", async () => {
    state.result = { error: { message: "permission denied for table projects" } };

    const result = await updateProjectStatus(
      "company-1",
      statusForm({ project_id: "project-1", status: "finalizado" }),
    );

    expect(result).toEqual({ error: "permission denied for table projects" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports an error when RLS matches zero rows instead of failing silently", async () => {
    state.result = { data: [], error: null };

    const result = await updateProjectStatus(
      "company-1",
      statusForm({ project_id: "project-1", status: "finalizado" }),
    );

    expect(result.error).toMatch(/permiso/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an invalid status", async () => {
    const result = await updateProjectStatus(
      "company-1",
      statusForm({ project_id: "project-1", status: "active" }),
    );

    expect(result.error).toMatch(/Estado inválido/);
  });

  it("requires a motivo for en_espera", async () => {
    const result = await updateProjectStatus(
      "company-1",
      statusForm({ project_id: "project-1", status: "en_espera", hold_reason: "  " }),
    );

    expect(result.error).toMatch(/motivo/);
  });
});

describe("addProjectQuote", () => {
  const initial = { error: null };

  it("returns the real database error message", async () => {
    state.result = { error: { message: "insert or update violates foreign key", code: "23503" } };

    const result = await addProjectQuote(
      "company-1",
      "project-1",
      initial,
      statusForm({ quote_number: "1691" }),
    );

    expect(result).toEqual({ error: "insert or update violates foreign key" });
  });

  it("keeps the friendly message for a duplicate quote number", async () => {
    state.result = { error: { message: "duplicate key value", code: "23505" } };

    const result = await addProjectQuote(
      "company-1",
      "project-1",
      initial,
      statusForm({ quote_number: "1691" }),
    );

    expect(result.error).toMatch(/ya está en uso/);
  });

  it("succeeds and revalidates the project page", async () => {
    state.result = { error: null };

    const result = await addProjectQuote(
      "company-1",
      "project-1",
      initial,
      statusForm({ quote_number: "1691" }),
    );

    expect(result).toEqual({ error: null });
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/projects/project-1");
  });
});
