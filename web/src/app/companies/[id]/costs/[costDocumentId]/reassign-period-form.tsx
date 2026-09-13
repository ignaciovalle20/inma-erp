"use client";

import { useActionState } from "react";
import {
  reassignCostDocumentPeriod,
  type ReassignPeriodState,
} from "./actions";

/** Formats a "YYYY-MM-01" period date as "September 2026". */
function formatPeriod(period: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Story 6.6: "Reassign period" form + audit note for a cost document.
 * Mirrors the sales edit page's ReassignPeriodSection -- same reasoning
 * there for why the setter is shown as "you"/"another user" rather
 * than resolving a display name (no such lookup exists anywhere in
 * this codebase yet; building one is out of scope for this story).
 * This is the one write path this otherwise read-only detail page
 * (Story 6.4's own boundary) gets, and it's a strictly narrower
 * capability than full document editing -- it can only ever touch the
 * three period-recognition columns (see reassign_cost_document_period).
 */
export function ReassignPeriodForm({
  companyId,
  costDocumentId,
  recognizedPeriod,
  recognizedPeriodSetBy,
  recognizedPeriodSetAt,
  currentUserId,
  currentUserEmail,
}: {
  companyId: string;
  costDocumentId: string;
  recognizedPeriod: string | null;
  recognizedPeriodSetBy: string | null;
  recognizedPeriodSetAt: string | null;
  currentUserId: string | null;
  currentUserEmail: string | null;
}) {
  const reassignWithIds = reassignCostDocumentPeriod.bind(
    null,
    companyId,
    costDocumentId,
  );

  const initialState: ReassignPeriodState = { error: null };
  const [state, formAction, pending] = useActionState(
    reassignWithIds,
    initialState,
  );

  const setterLabel =
    recognizedPeriodSetBy && currentUserId === recognizedPeriodSetBy
      ? (currentUserEmail ?? "you")
      : "another user";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-black/[.08] p-4 dark:border-white/[.145]">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Recognized period
      </h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-500">
        By default, this document is recognized in its document date&apos;s
        month for every report. Reassign it here if its cost should instead
        be recognized in a different month (e.g. a multi-month project) --
        this never changes the document date or any amount.
      </p>

      {recognizedPeriod && recognizedPeriodSetAt ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Recognized in {formatPeriod(recognizedPeriod)}, reassigned by{" "}
          {setterLabel} on{" "}
          {new Date(recognizedPeriodSetAt).toLocaleDateString("en-US")}.
        </p>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          Not reassigned -- recognized in its document date&apos;s month.
        </p>
      )}

      <form action={formAction} className="flex items-end gap-2">
        <div className="flex flex-col gap-1">
          <label
            htmlFor="recognized_period"
            className="text-xs text-zinc-500 dark:text-zinc-500"
          >
            Recognize in month
          </label>
          <input
            id="recognized_period"
            name="recognized_period"
            type="month"
            required
            defaultValue={recognizedPeriod ? recognizedPeriod.slice(0, 7) : ""}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium text-black transition-colors hover:bg-zinc-50 disabled:opacity-60 dark:border-white/[.145] dark:text-zinc-50 dark:hover:bg-zinc-900"
        >
          {pending ? "Reassigning..." : "Reassign"}
        </button>
      </form>

      {state.error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
