"use server";

import { createClient } from "@/lib/supabase/server";
import type { AiProvider } from "@/lib/dal";

const PROVIDERS: AiProvider[] = ["anthropic", "openai", "gemini"];

export type SaveAiSettingsState = {
  error: string | null;
  success: boolean;
  values: {
    provider: AiProvider;
    model: string;
  };
};

export async function saveAiSettings(
  prevState: SaveAiSettingsState,
  formData: FormData,
): Promise<SaveAiSettingsState> {
  const provider = formData.get("provider");
  const model = formData.get("model");
  const apiKey = formData.get("api_key");

  const values = {
    provider: (typeof provider === "string" && PROVIDERS.includes(provider as AiProvider)
      ? (provider as AiProvider)
      : prevState.values.provider),
    model: typeof model === "string" ? model : prevState.values.model,
  };

  if (typeof provider !== "string" || !PROVIDERS.includes(provider as AiProvider)) {
    return { error: "Elegí un proveedor válido.", success: false, values };
  }

  if (typeof model !== "string" || !model.trim()) {
    return { error: "El modelo es obligatorio.", success: false, values };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Sesión inválida.", success: false, values };
  }

  const trimmedKey = typeof apiKey === "string" ? apiKey.trim() : "";

  if (trimmedKey) {
    const { error } = await supabase.from("user_ai_settings").upsert(
      {
        user_id: user.id,
        provider,
        model: model.trim(),
        api_key: trimmedKey,
      },
      { onConflict: "user_id" },
    );

    if (error) {
      console.error(error);
      return { error: "No se pudo guardar la configuración.", success: false, values };
    }

    return { error: null, success: true, values };
  }

  // No new key typed -- only valid if a key is already saved, in which
  // case we update provider/model without touching the existing key.
  const { data: existing } = await supabase
    .from("user_ai_settings")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing) {
    return { error: "La API key es obligatoria.", success: false, values };
  }

  const { error } = await supabase
    .from("user_ai_settings")
    .update({ provider, model: model.trim() })
    .eq("user_id", user.id);

  if (error) {
    console.error(error);
    return { error: "No se pudo guardar la configuración.", success: false, values };
  }

  return { error: null, success: true, values };
}
