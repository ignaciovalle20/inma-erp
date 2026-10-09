"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { fieldInput } from "@/components/FormField";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { ProjectNote, ProjectStatus } from "@/lib/dal";
import { linkify } from "@/lib/linkify";
import { PROJECT_STATUS_LABEL } from "@/lib/projectStatus";
import {
  addProjectNote,
  deleteProjectNote,
  updateProjectNote,
  type ProjectLogResult,
} from "./actions";

const textAction =
  "text-small font-medium text-[var(--color-accent-strong)] disabled:opacity-40 disabled:cursor-default";

function statusLabel(code: string): string {
  return PROJECT_STATUS_LABEL[code as ProjectStatus] ?? code;
}

/** status_change bodies are "<old> -> <new>" (projects_log_status_change). */
function describeStatusChange(body: string): string {
  const match = /^(\S+) -> (\S+)$/.exec(body);
  return match ? `${statusLabel(match[1])} → ${statusLabel(match[2])}` : body;
}

/** Ctrl+Enter (Cmd+Enter on a Mac) inside a textarea. */
function isSubmitShortcut(event: React.KeyboardEvent) {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey);
}

function NoteBody({ body }: { body: string }) {
  return (
    <p className="whitespace-pre-wrap text-[13px] text-[var(--color-ink)] wrap-anywhere">
      {linkify(body).map((segment, index) =>
        segment.type === "link" ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent-strong)] underline"
          >
            {segment.value}
          </a>
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )}
    </p>
  );
}

/**
 * The job's timeline, newest first: members' notes (plain text, line
 * breaks kept, links clickable; the author can edit or delete them) and
 * the status changes the database logs on its own, shown smaller and
 * read-only. `authorNames` is null when the company has a single member:
 * then only the date and time are shown.
 */
export function ProjectNotes({
  companyId,
  projectId,
  notes,
  currentUserId,
  authorNames,
}: {
  companyId: string;
  projectId: string;
  notes: ProjectNote[];
  currentUserId: string;
  authorNames: Record<string, string> | null;
}) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<ProjectLogResult>, onSuccess?: () => void) {
    setError(null);
    startTransition(async () => {
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
    if (!draft.trim() || pending) return;
    const body = draft;
    run(
      () => addProjectNote(companyId, projectId, body),
      () => setDraft((current) => (current === body ? "" : current)),
    );
  }

  function saveEdit(note: ProjectNote) {
    if (!editText.trim() || pending) return;
    if (editText.trim() === note.body) {
      setEditingId(null);
      return;
    }
    run(() => updateProjectNote(companyId, projectId, note.id, editText), () => setEditingId(null));
  }

  function remove(note: ProjectNote) {
    if (!window.confirm("¿Borrar esta nota?")) return;
    run(() => deleteProjectNote(companyId, projectId, note.id));
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Notas</h2>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <textarea
          value={draft}
          rows={3}
          placeholder="¿Qué pasó en este trabajo?"
          aria-label="Nueva nota"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (isSubmitShortcut(event)) {
              event.preventDefault();
              add();
            }
          }}
          className={`${fieldInput} min-h-20 resize-y py-2`}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-small text-[var(--color-faint)]">Ctrl/⌘ + Enter para guardar</span>
          <Button type="submit" variant="secondary" pending={pending} disabled={!draft.trim()}>
            Agregar nota
          </Button>
        </div>
      </form>

      {error ? (
        <p role="alert" className="text-small text-[var(--color-negative-ink)] wrap-anywhere">
          {error}
        </p>
      ) : null}

      {notes.length === 0 ? (
        <p className="text-small text-[var(--color-muted)]">Todavía no hay notas.</p>
      ) : (
        <ol className="flex flex-col" aria-label="Notas del trabajo">
          {notes.map((note) =>
            note.kind === "status_change" ? (
              <li
                key={note.id}
                data-kind="status_change"
                className="flex flex-wrap items-baseline gap-x-2 border-b border-[var(--color-hairline-soft)] py-2 text-small text-[var(--color-muted)] last:border-b-0"
              >
                <span aria-hidden="true">•</span>
                <span>Estado: {describeStatusChange(note.body)}</span>
                <LocalDateTime value={note.created_at} className="text-[var(--color-faint)]" />
              </li>
            ) : (
              <li
                key={note.id}
                data-kind="note"
                className="flex flex-col gap-1 border-b border-[var(--color-hairline-soft)] py-2.5 last:border-b-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-small text-[var(--color-muted)]">
                    {authorNames ? (
                      <span className="font-medium text-[var(--color-ink-2)]">
                        {(note.author_id && authorNames[note.author_id]) ?? "Ex miembro"}
                      </span>
                    ) : null}
                    <LocalDateTime value={note.created_at} />
                    {note.edited_at ? <span className="text-[var(--color-faint)]">(editado)</span> : null}
                  </div>
                  {note.author_id === currentUserId && editingId !== note.id ? (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          setError(null);
                          setEditingId(note.id);
                          setEditText(note.body);
                        }}
                        className={textAction}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => remove(note)}
                        className="text-small font-medium text-[var(--color-muted)] hover:text-[var(--color-negative-ink)] disabled:opacity-40"
                      >
                        Borrar
                      </button>
                    </div>
                  ) : null}
                </div>
                {editingId === note.id ? (
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={editText}
                      rows={3}
                      autoFocus
                      aria-label="Editar nota"
                      onChange={(event) => setEditText(event.target.value)}
                      onKeyDown={(event) => {
                        if (isSubmitShortcut(event)) {
                          event.preventDefault();
                          saveEdit(note);
                        } else if (event.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      className={`${fieldInput} min-h-20 resize-y py-2`}
                    />
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={pending || !editText.trim()}
                        onClick={() => saveEdit(note)}
                        className={textAction}
                      >
                        {pending ? "Guardando…" : "Guardar"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="text-small text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <NoteBody body={note.body} />
                )}
              </li>
            ),
          )}
        </ol>
      )}
    </Card>
  );
}
