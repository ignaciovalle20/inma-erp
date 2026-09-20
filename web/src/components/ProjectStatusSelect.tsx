"use client";

import { useState, useTransition } from "react";
import { fieldInput } from "@/components/FormField";
import type { ProjectStatus } from "@/lib/dal";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from "@/lib/projectStatus";

/**
 * Kanban card's status control. No drag-and-drop (the repo has no DnD
 * library and this needs to work well on a phone) -- a <select> moves
 * the card instead, auto-submitting on change except into en_espera,
 * which needs a motivo first (docs/cambios-flujo-v2.md 4.1).
 *
 * The transition callback awaits the Server Action, so `pending` (and
 * the disabled controls) lasts until the save actually finishes. If it
 * fails, the card rolls back to the last saved status (the `status` /
 * `holdReason` props, which only change when the server data does) and
 * shows the real error message.
 */
export function ProjectStatusSelect({
  projectId,
  status,
  holdReason,
  updateStatus,
}: {
  projectId: string;
  status: ProjectStatus;
  holdReason: string | null;
  updateStatus: (formData: FormData) => Promise<{ error: string | null }>;
}) {
  const [value, setValue] = useState<ProjectStatus>(status);
  const [reason, setReason] = useState(holdReason ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(nextStatus: ProjectStatus, nextReason: string) {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("project_id", projectId);
      formData.set("status", nextStatus);
      formData.set("hold_reason", nextReason);

      let result: { error: string | null };
      try {
        result = await updateStatus(formData);
      } catch (thrown) {
        result = {
          error: thrown instanceof Error ? thrown.message : "No se pudo actualizar el estado.",
        };
      }

      if (result.error) {
        setValue(status);
        setReason(holdReason ?? "");
        setError(result.error);
      }
    });
  }

  function handleChange(next: ProjectStatus) {
    setError(null);
    setValue(next);
    if (next !== "en_espera") {
      save(next, "");
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <select
        value={value}
        disabled={pending}
        onChange={(event) => handleChange(event.target.value as ProjectStatus)}
        className={`${fieldInput} py-[6px] text-[12px]`}
      >
        {PROJECT_STATUSES.map((option) => (
          <option key={option} value={option}>
            {PROJECT_STATUS_LABEL[option]}
          </option>
        ))}
      </select>
      {value === "en_espera" ? (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            placeholder="Motivo"
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.target.value)}
            className={`${fieldInput} py-[6px] text-[12px]`}
          />
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() => save("en_espera", reason)}
            className="whitespace-nowrap text-[12px] font-medium text-[var(--color-accent-strong)] disabled:opacity-50"
          >
            {pending ? "…" : "Guardar"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-[11.5px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
