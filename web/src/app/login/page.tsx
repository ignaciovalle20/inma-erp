"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";
import { ThemeToggle } from "@/components/ThemeToggle";

const initialState: LoginState = { error: null };

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <div className="relative flex min-h-dvh flex-1 items-center justify-center bg-[var(--color-canvas)] px-4 py-24">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[360px]">
        <div className="mb-8 flex items-center gap-2">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] bg-[var(--color-accent)] text-[11px] font-bold text-[var(--color-on-accent)]">
            I
          </span>
          <span className="font-mono text-[11px] tracking-[0.16em] text-[var(--color-muted)]">
            INMA ERP
          </span>
        </div>
        <h1 className="text-[22px] font-semibold text-[var(--color-ink)]">Ingresar</h1>
        <p className="mt-1 mb-7 text-[13px] text-[var(--color-muted)]">
          Accedé con tu cuenta para continuar.
        </p>
        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="email"
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-2)]"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-2.5 text-[13.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="password"
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-ink-2)]"
            >
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface)] px-3 py-2.5 text-[13.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          {state.error ? (
            <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="mt-2 flex h-[42px] w-full items-center justify-center rounded-lg bg-[var(--color-accent)] text-[13px] font-medium text-[var(--color-on-accent)] disabled:opacity-60"
          >
            {pending ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
        <p className="mt-6 text-center text-[12px] text-[var(--color-muted)]">
          INMA ERP · Inmasoft
        </p>
      </div>
    </div>
  );
}
