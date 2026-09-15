"use client";

import { useActionState, useState } from "react";
import type { AiProvider, AiSettings } from "@/lib/dal";
import { saveAiSettings, type SaveAiSettingsState } from "./actions";
import { Field, fieldInput, fieldLabel } from "@/components/FormField";
import { Button } from "@/components/Button";

type ModelInfo = { id: string; label: string };

const PROVIDER_OPTIONS: { value: AiProvider; label: string }[] = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "gemini", label: "Google (Gemini)" },
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
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(state.values.model);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [manualModel, setManualModel] = useState(false);

  const canFetchModels = apiKey.trim().length > 0 || settings?.hasApiKey;

  async function fetchModels() {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const response = await fetch("/api/assistant/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() || undefined }),
      });
      const data = await response.json();
      if (!response.ok) {
        setModelsError(
          data.error === "missing_api_key"
            ? "Escribí tu API key para buscar los modelos disponibles."
            : "No pude obtener la lista de modelos con esa key. Podés escribir el modelo a mano.",
        );
        setModels(null);
        return;
      }
      setModels(data.models);
      setManualModel(false);
      if (data.models.length > 0 && !data.models.some((m: ModelInfo) => m.id === model)) {
        setModel(data.models[0].id);
      }
    } catch {
      setModelsError("No pude conectarme para buscar los modelos. Podés escribir el modelo a mano.");
      setModels(null);
    } finally {
      setLoadingModels(false);
    }
  }

  function handleProviderChange(next: AiProvider) {
    setProvider(next);
    setModels(null);
    setModelsError(null);
    setManualModel(false);
  }

  return (
    <form action={formAction} className="flex flex-col gap-5 p-6">
      <Field label="Proveedor" htmlFor="provider">
        <select
          id="provider"
          name="provider"
          required
          value={provider}
          onChange={(event) => handleProviderChange(event.target.value as AiProvider)}
          className={fieldInput}
        >
          {PROVIDER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
        <div className="flex gap-2">
          <input
            id="api_key"
            name="api_key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={settings?.hasApiKey ? "•••• configurada" : "sk-..."}
            className={`flex-1 ${fieldInput}`}
          />
          <button
            type="button"
            onClick={fetchModels}
            disabled={!canFetchModels || loadingModels}
            className="whitespace-nowrap rounded-lg border border-[var(--color-hairline)] bg-white px-3 py-[9px] text-[13px] font-medium text-[var(--color-ink)] disabled:opacity-50"
          >
            {loadingModels ? "Buscando…" : "Buscar modelos"}
          </button>
        </div>
        {modelsError ? (
          <p className="text-[11.5px] text-[var(--color-negative-ink)]">{modelsError}</p>
        ) : null}
      </Field>

      <Field label="Modelo" htmlFor="model">
        {models && models.length > 0 && !manualModel ? (
          <div className="flex flex-col gap-1.5">
            <select
              id="model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className={fieldInput}
            >
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setManualModel(true)}
              className="self-start text-[11.5px] text-[var(--color-accent-strong)]"
            >
              Escribir el modelo a mano
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <input
              id="model"
              type="text"
              required
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="Nombre del modelo"
              className={fieldInput}
            />
            {models && models.length > 0 ? (
              <button
                type="button"
                onClick={() => setManualModel(false)}
                className="self-start text-[11.5px] text-[var(--color-accent-strong)]"
              >
                Elegir de la lista
              </button>
            ) : (
              <p className="text-[11.5px] text-[var(--color-muted)]">
                Escribí tu API key y tocá &quot;Buscar modelos&quot; para elegir de una lista en vez de
                escribir el nombre a mano.
              </p>
            )}
          </div>
        )}
      </Field>
      <input type="hidden" name="model" value={model} />

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
