import { NextResponse } from "next/server";
import { getSession } from "@/lib/dal";
import type { AiProvider } from "@/lib/dal";
import { getAiSettingsWithKey } from "@/lib/ai/settings";
import { getProviderClient } from "@/lib/ai/providers";

const PROVIDERS: AiProvider[] = ["anthropic", "openai", "gemini"];

type ModelsRequestBody = {
  provider?: AiProvider;
  apiKey?: string;
};

/**
 * Looks up which models an API key can use, so the settings form can
 * offer a dropdown instead of a free-text field. Takes the key straight
 * from the request body when the user just typed a new one (not saved
 * yet); falls back to the already-saved key for that provider when the
 * field was left blank (see form.tsx's "keep the existing key" flow).
 */
export async function POST(request: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: ModelsRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.provider || !PROVIDERS.includes(body.provider)) {
    return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
  }

  let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  if (!apiKey) {
    const saved = await getAiSettingsWithKey();
    if (!saved || saved.provider !== body.provider) {
      return NextResponse.json({ error: "missing_api_key" }, { status: 400 });
    }
    apiKey = saved.apiKey;
  }

  try {
    const models = await getProviderClient(body.provider).listModels(apiKey);
    return NextResponse.json({ models });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "provider_error" }, { status: 502 });
  }
}
