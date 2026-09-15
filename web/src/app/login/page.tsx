"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <div className="flex flex-1 items-center justify-center bg-[#14161a] px-4">
      <div className="w-full max-w-[360px]">
        <div className="mb-8 flex items-center gap-2">
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[5px] bg-[var(--color-accent)] text-[11px] font-bold text-[#f2fbf8]">
            I
          </span>
          <span className="font-mono text-[11px] tracking-[0.16em] text-[#8a9099]">
            INMA ERP
          </span>
        </div>
        <h1 className="text-[22px] font-semibold text-[#f2f2ef]">Ingresar</h1>
        <p className="mt-1 mb-7 text-[13px] text-[#8a9099]">
          Accedé con tu cuenta para continuar.
        </p>
        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="email"
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#767c85]"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="rounded-lg border border-white/10 bg-[#1c1f25] px-3 py-2.5 text-[13.5px] text-[#e8e8e4] outline-none focus:border-white/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="password"
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#767c85]"
            >
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="rounded-lg border border-white/10 bg-[#1c1f25] px-3 py-2.5 text-[13.5px] text-[#e8e8e4] outline-none focus:border-white/30"
            />
          </div>
          {state.error ? (
            <p className="text-[13px] text-[#e8a79b]" role="alert">
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="mt-2 flex h-[42px] w-full items-center justify-center rounded-lg bg-[var(--color-accent)] text-[13px] font-medium text-[#f2fbf8] disabled:opacity-60"
          >
            {pending ? "Ingresando…" : "Ingresar"}
          </button>
        </form>
        <p className="mt-6 text-center text-[12px] text-[#6c727b]">
          INMA ERP · Inmasoft
        </p>
      </div>
    </div>
  );
}
