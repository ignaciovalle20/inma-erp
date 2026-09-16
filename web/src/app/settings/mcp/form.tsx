"use client";

import { useActionState, useState } from "react";
import type { McpAccessToken } from "@/lib/dal";
import { createMcpToken, revokeMcpToken, type CreateMcpTokenState } from "./actions";
import { Field, fieldInput } from "@/components/FormField";
import { Button } from "@/components/Button";
import { Badge } from "@/components/Badge";

const initialState: CreateMcpTokenState = { error: null, token: null };

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es");
}

export function McpTokensForm({ tokens }: { tokens: McpAccessToken[] }) {
  const [state, formAction, pending] = useActionState(createMcpToken, initialState);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function handleRevoke(tokenId: string) {
    setRevokingId(tokenId);
    await revokeMcpToken(tokenId);
    setRevokingId(null);
  }

  return (
    <div className="flex flex-col">
      {state.token ? (
        <div className="border-b border-[var(--color-hairline)] bg-[var(--color-warning-soft)] p-5">
          <p className="text-[13px] font-semibold text-[var(--color-warning-ink)]">
            Copiá este token ahora -- no se puede volver a ver.
          </p>
          <code className="mt-2 block break-all rounded-[8px] border border-[var(--color-warning-soft-border)] bg-[var(--color-surface)] p-3 text-[12.5px] text-[var(--color-ink)]">
            {state.token}
          </code>
        </div>
      ) : null}

      <form action={formAction} className="flex flex-col gap-4 border-b border-[var(--color-hairline)] p-5">
        <Field label="Nuevo token" htmlFor="label">
          <input
            id="label"
            name="label"
            type="text"
            required
            placeholder='ej. "Claude Code - notebook"'
            className={fieldInput}
          />
        </Field>
        {state.error ? (
          <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
            {state.error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" pending={pending} pendingLabel="Generando…">
            Generar token
          </Button>
        </div>
      </form>

      <div className="flex flex-col">
        {tokens.length === 0 ? (
          <p className="p-5 text-[13px] text-[var(--color-muted)]">Todavía no generaste ningún token.</p>
        ) : (
          tokens.map((token) => (
            <div
              key={token.id}
              className="flex items-center justify-between gap-3 border-b border-[var(--color-hairline-soft)] px-5 py-3 last:border-b-0"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--color-ink)]">{token.label}</span>
                  {token.revoked_at ? <Badge variant="neutral">Revocado</Badge> : null}
                </div>
                <span className="text-[11.5px] text-[var(--color-muted)]">
                  Creado {formatDate(token.created_at)} · Último uso {formatDate(token.last_used_at)}
                </span>
              </div>
              {token.revoked_at ? null : (
                <button
                  type="button"
                  disabled={revokingId === token.id}
                  onClick={() => handleRevoke(token.id)}
                  className="cursor-pointer text-[12.5px] font-medium text-[var(--color-negative-ink)] disabled:cursor-default disabled:opacity-60"
                >
                  {revokingId === token.id ? "Revocando…" : "Revocar"}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
