import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getSession, type AiProvider } from "@/lib/dal";
import { decryptApiKey } from "@/lib/ai/keyCrypto";

export type AiSettingsWithKey = {
  provider: AiProvider;
  model: string;
  apiKey: string;
};

/**
 * Same row as getAiSettings, but including the api_key, decrypted
 * (lib/ai/keyCrypto.ts: the database only holds the ciphertext). Import this
 * ONLY from the assistant's route handler (server-only) -- never from a
 * Server Component that could pass the result down into a Client
 * Component and leak the key into the page's serialized props.
 */
export const getAiSettingsWithKey = cache(
  async (): Promise<AiSettingsWithKey | null> => {
    const user = await getSession();

    if (!user) {
      return null;
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("user_ai_settings")
      .select("provider, model, api_key")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !data) {
      if (error) {
        console.error(error);
      }
      return null;
    }

    let apiKey: string;
    try {
      apiKey = decryptApiKey(data.api_key);
    } catch (decryptError) {
      // Wrong or missing AI_SETTINGS_ENCRYPTION_KEY: same as not configured.
      console.error(decryptError);
      return null;
    }

    return {
      provider: data.provider,
      model: data.model,
      apiKey,
    };
  },
);
