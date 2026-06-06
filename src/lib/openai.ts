/**
 * Cliente minimo de OpenAI Chat Completions con soporte de tool-calling.
 *
 * Reutiliza el mismo patron que `modules/products/products.ai.ts` (fetch directo
 * con la API key del tenant), pero generalizado para el loop del agente: acepta
 * `tools` y devuelve el mensaje del asistente, que puede incluir `tool_calls`.
 */

import { AppError } from "./app-error";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
  error?: { message?: string };
};

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | undefined;
}

export async function chatCompletion(opts: {
  apiKey: string;
  model: string;
  temperature?: number;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}): Promise<ChatCompletionResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 900,
      messages: opts.messages,
      ...(opts.tools && opts.tools.length
        ? { tools: opts.tools, tool_choice: "auto" }
        : {}),
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const data = (await response.json()) as OpenAIChatResponse;
      detail = data?.error?.message ?? "";
    } catch {
      // ignore
    }
    throw new AppError(
      `Error al consultar OpenAI (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status === 401 ? 401 : 502,
    );
  }

  const data = (await response.json()) as OpenAIChatResponse;
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? null,
    toolCalls: message?.tool_calls ?? [],
    finishReason: data.choices?.[0]?.finish_reason,
  };
}
