"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Card } from "@/components/Card";
import { fieldInputSm } from "@/components/FormField";
import type { ProjectChecklistItem } from "@/lib/dal";
import {
  addChecklistItem,
  deleteChecklistItem,
  moveChecklistItem,
  updateChecklistItem,
  type ProjectLogResult,
} from "./actions";

const textAction =
  "text-small font-medium text-[var(--color-accent-strong)] disabled:opacity-40 disabled:cursor-default";
const iconAction =
  "inline-flex h-6 w-6 items-center justify-center rounded text-[var(--color-muted)] hover:bg-[var(--color-row)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:hover:bg-transparent";

/** Stroke icons in currentColor (text arrows fall back to colored glyphs on some systems). */
function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

const ICON_UP = "M4 10l4-4 4 4";
const ICON_DOWN = "M4 6l4 4 4-4";
const ICON_REMOVE = "M4.5 4.5l7 7M11.5 4.5l-7 7";

/**
 * The job's checklist: add (Enter), tick, rename (Enter saves, Esc
 * cancels), move up/down and delete. Every change is a Server Action
 * followed by the page's revalidation, so the list always shows what was
 * saved; while one runs the controls are disabled.
 */
export function ProjectChecklist({
  companyId,
  projectId,
  items,
}: {
  companyId: string;
  projectId: string;
  items: ProjectChecklistItem[];
}) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A tick shows at once; it falls back to the saved value if the save
  // fails (the transition ends without new props).
  const [shownItems, setShownDone] = useOptimistic(
    items,
    (current, change: { id: string; is_done: boolean }) =>
      current.map((item) => (item.id === change.id ? { ...item, is_done: change.is_done } : item)),
  );

  const done = shownItems.filter((item) => item.is_done).length;

  function run(
    action: () => Promise<ProjectLogResult>,
    onSuccess?: () => void,
    optimistic?: () => void,
  ) {
    setError(null);
    startTransition(async () => {
      optimistic?.();
      let result: ProjectLogResult;
      try {
        result = await action();
      } catch (thrown) {
        result = { error: thrown instanceof Error ? thrown.message : "No se pudo guardar." };
      }
      if (result.error) {
        setError(result.error);
      } else {
        onSuccess?.();
      }
    });
  }

  function add() {
    const text = draft.trim();
    if (!text || pending) return;
    // Only clears what was saved: the next item may already be typed.
    run(
      () => addChecklistItem(companyId, projectId, text),
      () => setDraft((current) => (current.trim() === text ? "" : current)),
    );
  }

  function startEdit(item: ProjectChecklistItem) {
    setError(null);
    setEditingId(item.id);
    setEditText(item.text);
  }

  function saveEdit(item: ProjectChecklistItem) {
    if (pending) return;
    const text = editText.trim();
    if (!text || text === item.text) {
      setEditingId(null);
      return;
    }
    run(() => updateChecklistItem(companyId, projectId, item.id, { text }), () => setEditingId(null));
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Checklist</h2>
        {shownItems.length > 0 ? (
          <span
            className="font-mono text-small tabular-nums text-[var(--color-muted)]"
            aria-label={`${done} de ${shownItems.length} ítems hechos`}
            data-testid="checklist-progress"
          >
            {done}/{shownItems.length}
          </span>
        ) : null}
      </div>

      {shownItems.length > 0 ? (
        <ul className="flex flex-col">
          {shownItems.map((item, index) => (
            <li
              key={item.id}
              className="group flex min-w-0 items-start gap-2 border-b border-[var(--color-hairline-soft)] py-1.5 last:border-b-0"
            >
              <input
                type="checkbox"
                checked={item.is_done}
                disabled={pending}
                aria-label={`Marcar “${item.text}” como ${item.is_done ? "pendiente" : "hecho"}`}
                onChange={(event) => {
                  const isDone = event.target.checked;
                  run(
                    () => updateChecklistItem(companyId, projectId, item.id, { is_done: isDone }),
                    undefined,
                    () => setShownDone({ id: item.id, is_done: isDone }),
                  );
                }}
                className="mt-[3px] h-4 w-4 flex-none accent-[var(--color-accent)]"
              />
              {editingId === item.id ? (
                <input
                  type="text"
                  autoFocus
                  value={editText}
                  disabled={pending}
                  aria-label="Texto del ítem"
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveEdit(item);
                    } else if (event.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  onBlur={() => saveEdit(item)}
                  className={`${fieldInputSm} min-w-0 flex-1`}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => startEdit(item)}
                  title="Editar"
                  className={`min-w-0 flex-1 cursor-text text-left text-[13px] wrap-anywhere ${
                    item.is_done ? "text-[var(--color-muted)] line-through" : "text-[var(--color-ink)]"
                  }`}
                >
                  {item.text}
                </button>
              )}
              <div className="flex flex-none items-center gap-0.5">
                <button
                  type="button"
                  disabled={pending || index === 0}
                  aria-label={`Subir “${item.text}”`}
                  onClick={() => run(() => moveChecklistItem(companyId, projectId, item.id, -1))}
                  title="Subir"
                  className={iconAction}
                >
                  <Icon path={ICON_UP} />
                </button>
                <button
                  type="button"
                  disabled={pending || index === shownItems.length - 1}
                  aria-label={`Bajar “${item.text}”`}
                  onClick={() => run(() => moveChecklistItem(companyId, projectId, item.id, 1))}
                  title="Bajar"
                  className={iconAction}
                >
                  <Icon path={ICON_DOWN} />
                </button>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`Borrar “${item.text}”`}
                  onClick={() => run(() => deleteChecklistItem(companyId, projectId, item.id))}
                  title="Borrar"
                  className={`${iconAction} hover:text-[var(--color-negative-ink)]`}
                >
                  <Icon path={ICON_REMOVE} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-small text-[var(--color-muted)]">Todavía no hay ítems.</p>
      )}

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        {/* Never disabled, so the focus stays here to type the next item. */}
        <input
          type="text"
          value={draft}
          placeholder="Nuevo ítem y Enter"
          aria-label="Nuevo ítem del checklist"
          onChange={(event) => setDraft(event.target.value)}
          className={`${fieldInputSm} min-w-0 flex-1`}
        />
        <button type="submit" disabled={pending || !draft.trim()} className={textAction}>
          Agregar
        </button>
      </form>

      {error ? (
        <p role="alert" className="text-small text-[var(--color-negative-ink)] wrap-anywhere">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
