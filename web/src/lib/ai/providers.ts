import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI, Type as GeminiType } from "@google/genai";
import type { AiProvider } from "@/lib/dal";

/**
 * JSON-Schema-ish description of a tool's arguments -- kept to the
 * small subset every provider's SDK can consume once translated (see
 * toGeminiSchema below for the one provider whose SDK wants its own
 * enum for `type` instead of the plain JSON Schema string).
 */
export type JsonSchema = {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  // Opaque, provider-specific data a provider needs echoed back on the
  // next call within the same request's tool loop (e.g. Gemini's
  // thought_signature). Only ever written and read by the same
  // provider adapter that produced it -- see GeminiProviderClient.
  providerMeta?: unknown;
};

export type ToolResult = {
  id: string;
  name: string;
  result: unknown;
};

/**
 * Provider-agnostic representation of one turn of the conversation,
 * including the assistant's tool_use/tool_result round-trips that
 * happen *within* a single user turn (see chat route handler's loop).
 * Each adapter below translates this whole array into its own native
 * message format on every call -- there's no cross-request session
 * kept on the provider side, the client always resends full history.
 */
export type InternalMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool_results"; results: ToolResult[] };

export type ProviderResponse = {
  text: string | null;
  toolCalls: ToolCall[];
};

export type ModelInfo = { id: string; label: string };

export interface AiProviderClient {
  send(args: {
    apiKey: string;
    model: string;
    system: string;
    tools: ToolDefinition[];
    messages: InternalMessage[];
  }): Promise<ProviderResponse>;

  listModels(apiKey: string): Promise<ModelInfo[]>;
}

const MAX_OUTPUT_TOKENS = 2048;

class AnthropicProviderClient implements AiProviderClient {
  async send({ apiKey, model, system, tools, messages }: Parameters<AiProviderClient["send"]>[0]): Promise<ProviderResponse> {
    const client = new Anthropic({ apiKey });

    const anthropicMessages: Anthropic.MessageParam[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        anthropicMessages.push({ role: "user", content: message.content });
      } else if (message.role === "assistant") {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (message.content) {
          blocks.push({ type: "text", text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          });
        }
        anthropicMessages.push({ role: "assistant", content: blocks });
      } else {
        anthropicMessages.push({
          role: "user",
          content: message.results.map((result) => ({
            type: "tool_result" as const,
            tool_use_id: result.id,
            content: JSON.stringify(result.result ?? null),
          })),
        });
      }
    }

    const response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: anthropicMessages,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Tool.InputSchema,
      })),
    });

    let text: string | null = null;
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        text = (text ?? "") + block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return { text, toolCalls };
  }

  async listModels(apiKey: string): Promise<ModelInfo[]> {
    const client = new Anthropic({ apiKey });
    const page = await client.models.list({ limit: 100 });
    return page.data
      .map((model) => ({ id: model.id, label: model.display_name ?? model.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
}

class OpenAiProviderClient implements AiProviderClient {
  async send({ apiKey, model, system, tools, messages }: Parameters<AiProviderClient["send"]>[0]): Promise<ProviderResponse> {
    const client = new OpenAI({ apiKey });

    const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
    ];
    for (const message of messages) {
      if (message.role === "user") {
        openAiMessages.push({ role: "user", content: message.content });
      } else if (message.role === "assistant") {
        openAiMessages.push({
          role: "assistant",
          content: message.content,
          tool_calls: message.toolCalls?.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        });
      } else {
        for (const result of message.results) {
          openAiMessages.push({
            role: "tool",
            tool_call_id: result.id,
            content: JSON.stringify(result.result ?? null),
          });
        }
      }
    }

    const response = await client.chat.completions.create({
      model,
      messages: openAiMessages,
      tools: tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
        },
      })),
    });

    const message = response.choices[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).flatMap((call) => {
      if (call.type !== "function") return [];
      try {
        return [{
          id: call.id,
          name: call.function.name,
          arguments: JSON.parse(call.function.arguments || "{}"),
        }];
      } catch {
        return [{ id: call.id, name: call.function.name, arguments: {} }];
      }
    });

    return { text: message?.content ?? null, toolCalls };
  }

  async listModels(apiKey: string): Promise<ModelInfo[]> {
    const client = new OpenAI({ apiKey });
    const page = await client.models.list();
    const excluded =
      /embedding|whisper|tts|dall-e|moderation|davinci|babbage|ada-|curie|audio|realtime|transcribe|image|computer-use/i;
    return page.data
      .filter((model) => !excluded.test(model.id))
      .map((model) => ({ id: model.id, label: model.id }))
      .sort((a, b) => b.id.localeCompare(a.id));
  }
}

/** Gemini's Schema type wants an uppercase `type` enum, not JSON Schema's lowercase strings. */
function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const typeMap: Record<JsonSchema["type"], unknown> = {
    object: GeminiType.OBJECT,
    string: GeminiType.STRING,
    number: GeminiType.NUMBER,
    integer: GeminiType.INTEGER,
    boolean: GeminiType.BOOLEAN,
    array: GeminiType.ARRAY,
  };

  const result: Record<string, unknown> = { type: typeMap[schema.type] };
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.required) result.required = schema.required;
  if (schema.items) result.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    );
  }
  return result;
}

class GeminiProviderClient implements AiProviderClient {
  async send({ apiKey, model, system, tools, messages }: Parameters<AiProviderClient["send"]>[0]): Promise<ProviderResponse> {
    const client = new GoogleGenAI({ apiKey });

    type GeminiPart = {
      text?: string;
      functionCall?: { name: string; args: Record<string, unknown> };
      functionResponse?: { name: string; response: Record<string, unknown> };
      // Gemini 2.5's thinking models attach this to a functionCall part
      // and require it echoed back on the exact same part when the
      // conversation is replayed -- see the comment on ToolCall.providerMeta.
      thoughtSignature?: string;
    };
    type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

    const contents: GeminiContent[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        contents.push({ role: "user", parts: [{ text: message.content }] });
      } else if (message.role === "assistant") {
        const parts: GeminiPart[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          const thoughtSignature = (call.providerMeta as { thoughtSignature?: string } | undefined)
            ?.thoughtSignature;
          parts.push({
            functionCall: { name: call.name, args: call.arguments },
            ...(thoughtSignature ? { thoughtSignature } : {}),
          });
        }
        contents.push({ role: "model", parts });
      } else {
        contents.push({
          role: "user",
          parts: message.results.map((result) => ({
            functionResponse: {
              name: result.name,
              // Gemini's functionResponse.response is a proto Struct --
              // it must be a JSON *object*, never a bare array (several
              // tools, e.g. list_clients, return one) or a scalar, or
              // the request is rejected with "Proto field is not
              // repeating, cannot start list."
              response:
                result.result &&
                typeof result.result === "object" &&
                !Array.isArray(result.result)
                  ? (result.result as Record<string, unknown>)
                  : { result: result.result ?? null },
            },
          })),
        });
      }
    }

    const response = await client.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: system,
        tools: [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: toGeminiSchema(tool.parameters),
            })),
          },
        ],
      },
    });

    // Walk the raw parts instead of the response.functionCalls
    // convenience getter -- that getter drops each part's
    // thoughtSignature, which the next request in this same tool loop
    // needs to echo back (see the parts-building loop above) or Gemini
    // rejects the request with "Function call is missing a
    // thought_signature".
    const responseParts = (response.candidates?.[0]?.content?.parts ?? []) as GeminiPart[];
    let text: string | null = null;
    const toolCalls: ToolCall[] = [];
    let callIndex = 0;
    for (const part of responseParts) {
      if (part.text) {
        text = (text ?? "") + part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${callIndex++}`,
          name: part.functionCall.name ?? "",
          arguments: part.functionCall.args ?? {},
          providerMeta: part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : undefined,
        });
      }
    }

    return { text, toolCalls };
  }

  async listModels(apiKey: string): Promise<ModelInfo[]> {
    const client = new GoogleGenAI({ apiKey });
    const pager = await client.models.list();
    const models: ModelInfo[] = [];
    for await (const model of pager) {
      const actions = model.supportedActions ?? [];
      if (actions.length > 0 && !actions.includes("generateContent")) continue;
      const id = (model.name ?? "").replace(/^models\//, "");
      if (!id || id.includes("embedding")) continue;
      models.push({ id, label: model.displayName || id });
    }
    return models.sort((a, b) => a.label.localeCompare(b.label));
  }
}

const PROVIDERS: Record<AiProvider, AiProviderClient> = {
  anthropic: new AnthropicProviderClient(),
  openai: new OpenAiProviderClient(),
  gemini: new GeminiProviderClient(),
};

export function getProviderClient(provider: AiProvider): AiProviderClient {
  return PROVIDERS[provider];
}
