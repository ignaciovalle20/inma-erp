"use client";

import { useActionState, useState } from "react";
import {
  voidSalesDocument,
  type VoidSalesDocumentState,
} from "./[salesDocumentId]/edit/actions";

// Row-level "delete" action on the sales list. There's no hard delete
// for sales_documents (see void_sales_document's migration comment --
// rows are never deleted), so this reuses the same voidSalesDocument
// RPC as the edit page's "Anular este documento" section, just
// triggered from a trash icon with an inline confirm instead of a
// dedicated section.
export function VoidDocumentRowAction({
  companyId,
  salesDocumentId,
}: {
  companyId: string;
  salesDocumentId: string;
}) {
  const voidSalesDocumentWithIds = voidSalesDocument.bind(
    null,
    companyId,
    salesDocumentId,
  );

  const initialState: VoidSalesDocumentState = { error: null };
  const [state, formAction, pending] = useActionState(
    voidSalesDocumentWithIds,
    initialState,
  );
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <form action={formAction} className="flex items-center justify-end gap-1.5">
        <span className="text-[12px] text-[var(--color-negative-ink)]">¿Eliminar?</span>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-negative)] px-2 py-1 text-[12px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "…" : "Sí"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="rounded-md border border-[var(--color-hairline)] px-2 py-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        >
          No
        </button>
        {state.error ? (
          <span className="text-[12px] text-[var(--color-negative-ink)]" role="alert">
            {state.error}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      aria-label="Eliminar documento"
      title="Eliminar"
      className="rounded-md p-1 text-[var(--color-muted)] hover:bg-[var(--color-negative-soft)] hover:text-[var(--color-negative-ink)]"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
      </svg>
    </button>
  );
}
