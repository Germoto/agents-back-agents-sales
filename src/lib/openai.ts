/**
 * Cliente minimo de OpenAI Chat Completions con soporte de tool-calling.
 *
 * Reutiliza el mismo patron que `modules/products/products.ai.ts` (fetch directo
 * con la API key del tenant), pero generalizado para el loop del agente: acepta
 * `tools` y devuelve el mensaje del asistente, que puede incluir `tool_calls`.
 */

import { AppError } from "./app-error";
import { chatBodyParams, claudeModelCaps, THINKING_MAX_TOKENS_FLOOR } from "./ai-providers";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Parte de un mensaje multimodal (texto + imágenes por URL). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
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

/**
 * POST a `${base}/chat/completions` con red de seguridad para Claude: si el
 * cuerpo llevaba `thinking` y el proveedor responde 400, reintenta UNA vez sin
 * `thinking` y con margen de max_tokens (el pensamiento activo lo consume).
 * Para OpenAI/Gemini el cuerpo nunca lleva `thinking`, así que es un POST normal.
 */
export async function postChatCompletions(
  baseUrl: string | undefined,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const base = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const post = (b: Record<string, unknown>) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(b),
    });
  const response = await post(body);
  if (response.status !== 400 || !("thinking" in body)) return response;
  let detail = "";
  try {
    detail = String(((await response.json()) as OpenAIChatResponse)?.error?.message ?? "");
  } catch {
    // ignore
  }
  console.warn(`[ai] ${String(body.model)} rechazó la petición con thinking (400${detail ? `: ${detail}` : ""}); reintento sin thinking`);
  const { thinking: _omit, ...rest } = body;
  const maxTokens = Number(rest.max_tokens ?? 0);
  return post({ ...rest, max_tokens: Math.max(maxTokens, THINKING_MAX_TOKENS_FLOOR) });
}

export async function chatCompletion(opts: {
  apiKey: string;
  model: string;
  temperature?: number;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** "auto" (default) o forzar una herramienta concreta en esta llamada. */
  toolChoice?: "auto" | { type: "function"; function: { name: string } };
  maxTokens?: number;
  /** Base URL del proveedor (default OpenAI). Anthropic/Gemini exponen este mismo formato. */
  baseUrl?: string;
}): Promise<ChatCompletionResult> {
  const caps = claudeModelCaps(opts.baseUrl, opts.model);
  const messages = [...opts.messages];
  let toolChoice = opts.toolChoice ?? "auto";
  // Modelos que rechazan tool_choice forzado (Opus 5.5 / Sonnet 5.5): se pide
  // por instrucción y se deja "auto". El resto (OpenAI, Gemini, Haiku 5.5,
  // Claude anteriores) sigue con el forzado real.
  if (typeof toolChoice === "object" && !caps.forcedToolChoice) {
    messages.push({
      role: "system",
      content: `En esta respuesta DEBES llamar primero la herramienta ${toolChoice.function.name}, antes de escribir cualquier texto.`,
    });
    toolChoice = "auto";
  }
  const response = await postChatCompletions(opts.baseUrl, opts.apiKey, {
    model: opts.model,
    ...chatBodyParams(opts.baseUrl, opts.model, {
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens ?? 900,
    }),
    messages,
    ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: toolChoice } : {}),
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
      `Error al consultar el proveedor de IA (${response.status})${detail ? `: ${detail}` : ""}`,
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

/**
 * Igual que chatCompletion pero en STREAM (SSE OpenAI-compatible): entrega el
 * texto del asistente por fragmentos (onDelta) y acumula las tool_calls que
 * llegan troceadas. Devuelve el mismo resultado final que chatCompletion.
 * Si el proveedor no soporta stream (respuesta no-SSE), cae al modo normal.
 */
export async function chatCompletionStream(
  opts: Parameters<typeof chatCompletion>[0] & { onDelta: (text: string) => void },
): Promise<ChatCompletionResult> {
  const caps = claudeModelCaps(opts.baseUrl, opts.model);
  const messages = [...opts.messages];
  let toolChoice = opts.toolChoice ?? "auto";
  if (typeof toolChoice === "object" && !caps.forcedToolChoice) {
    messages.push({
      role: "system",
      content: `En esta respuesta DEBES llamar primero la herramienta ${toolChoice.function.name}, antes de escribir cualquier texto.`,
    });
    toolChoice = "auto";
  }
  const response = await postChatCompletions(opts.baseUrl, opts.apiKey, {
    model: opts.model,
    ...chatBodyParams(opts.baseUrl, opts.model, {
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens ?? 900,
    }),
    messages,
    stream: true,
    ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: toolChoice } : {}),
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
      `Error al consultar el proveedor de IA (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status === 401 ? 401 : 502,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    // Proveedor sin stream: respuesta completa normal.
    const data = (await response.json()) as OpenAIChatResponse;
    const message = data.choices?.[0]?.message;
    if (message?.content) opts.onDelta(message.content);
    return { content: message?.content ?? null, toolCalls: message?.tool_calls ?? [], finishReason: data.choices?.[0]?.finish_reason };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | undefined;
  const calls = new Map<number, ToolCall>();

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json: {
      choices?: Array<{
        delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
        finish_reason?: string | null;
      }>;
      error?: { message?: string };
    };
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error?.message) throw new AppError(`Error del proveedor de IA: ${json.error.message}`, 502);
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.delta?.content) {
      content += choice.delta.content;
      opts.onDelta(choice.delta.content);
    }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const current = calls.get(idx) ?? { id: tc.id ?? `call_${idx}`, type: "function" as const, function: { name: "", arguments: "" } };
      if (tc.id) current.id = tc.id;
      if (tc.function?.name) current.function.name += tc.function.name;
      if (tc.function?.arguments) current.function.arguments += tc.function.arguments;
      calls.set(idx, current);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      handleLine(line);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) handleLine(buffer.trim());

  return {
    content: content || null,
    toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
    finishReason,
  };
}

