"use client";

import { useActionState, useState } from "react";
import type { AiProvider, AiSettings } from "@/lib/dal";
import { saveAiSettings, type SaveAiSettingsState } from "./actions";
import { Field, fieldInput, fieldLabel } from "@/components/FormField";
import { Button } from "@/components/Button";

const PROVIDER_OPTIONS: { value: AiProvider; label: string; modelPlaceholder: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)", modelPlaceholder: "claude-sonnet-5" },
  { value: "openai", label: "OpenAI (GPT)", modelPlaceholder: "gpt-5" },
  { value: "gemini", label: "Google (Gemini)", modelPlaceholder: "gemini-2.5-pro" },
];

export function AiSettingsForm({ settings }: { settings: AiSettings | null }) {
  const initialState: SaveAiSettingsState = {
    error: null,
    success: false,
    values: {
      provider: settings?.provider ?? "anthropic",
      model: settings?.model ?? "",
    },
  };

  const [state, formAction, pending] = useActionState(saveAiSettings, initialState);
  const [provider, setProvider] = useState<AiProvider>(state.values.provider);

  const providerOption = PROVIDER_OPTIONS.find((option) => option.value === provider)!;

  return (
    <form action={formAction} className="flex flex-col gap-5 p-6">
      <Field label="Proveedor" htmlFor="provider">
        <select
          id="provider"
          name="provider"
          required
          value={provider}
          onChange={(event) => setProvider(event.target.value as AiProvider)}
          className={fieldInput}
        >
          {PROVIDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Modelo" htmlFor="model" hint={`Ej: ${providerOption.modelPlaceholder}`}>
        <input
          id="model"
          name="model"
          type="text"
          required
          defaultValue={state.values.model}
          placeholder={providerOption.modelPlaceholder}
          className={fieldInput}
        />
      </Field>

      <Field
        label="API key"
        htmlFor="api_key"
        hint={
          settings?.hasApiKey
            ? "Ya hay una key guardada. Dejá este campo vacío para conservarla, o escribí una nueva para reemplazarla."
            : "Se guarda del lado del servidor y nunca se muestra de nuevo en esta pantalla."
        }
      >
        <input
          id="api_key"
          name="api_key"
          type="password"
          autoComplete="off"
          placeholder={settings?.hasApiKey ? "•••• configurada" : "sk-..."}
          className={fieldInput}
        />
      </Field>

      {state.error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {state.error}
        </p>
      ) : null}

      {state.success ? (
        <p className="text-[13px] text-[var(--color-accent-strong)]" role="status">
          Configuración guardada.
        </p>
      ) : null}

      <p className={fieldLabel}>
        La API key queda protegida por permisos de base de datos, pero se almacena en texto plano
        -- no la reutilices para nada sensible.
      </p>

      <Button type="submit" pending={pending} pendingLabel="Guardando…">
        Guardar
      </Button>
    </form>
  );
}
