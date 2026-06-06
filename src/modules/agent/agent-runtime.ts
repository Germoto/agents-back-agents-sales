/**
 * Loop del agente: arma system prompt + historial, llama a OpenAI con
 * tool-calling y ejecuta herramientas hasta que el modelo produce el texto
 * final para el cliente. Reemplaza el mega-nodo de n8n.
 */

import { chatCompletion, type ChatMessage } from "../../lib/openai";
import { buildSystemPrompt } from "./agent-prompt";
import { TOOL_DEFINITIONS, executeTool, type TurnContext } from "./agent-tools";

const MAX_ITERATIONS = 6;
const FALLBACK_TEXT =
  "Disculpa, tuve un problema para procesar tu mensaje. ¿Me lo repites o me dices qué producto te interesa?";

/**
 * Ejecuta un turno completo. `history` debe incluir ya el último mensaje del
 * cliente (se lee de la BD después de persistirlo). Devuelve el texto final;
 * los adjuntos y acciones quedan acumulados en ctx.outbox / ctx.reminders.
 */
export async function runAgentTurn(ctx: TurnContext, history: ChatMessage[]): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx.config, ctx.state) },
    ...history,
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await chatCompletion({
      apiKey: ctx.config.openai.apiKey,
      model: ctx.config.openai.model,
      temperature: ctx.config.openai.temperature,
      messages,
      tools: TOOL_DEFINITIONS,
    });

    if (res.toolCalls.length) {
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        let parsed: Record<string, any> = {};
        try {
          parsed = JSON.parse(call.function.arguments || "{}");
        } catch {
          parsed = {};
        }
        const result = await executeTool(call.function.name, parsed, ctx).catch((err) =>
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "tool error" }),
        );
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      continue;
    }

    // Sin tool_calls => texto final para el cliente
    return (res.content ?? "").trim() || FALLBACK_TEXT;
  }

  // Si agotó iteraciones, fuerza un cierre en texto sin herramientas
  const closing = await chatCompletion({
    apiKey: ctx.config.openai.apiKey,
    model: ctx.config.openai.model,
    temperature: ctx.config.openai.temperature,
    messages: [
      ...messages,
      { role: "user", content: "Cierra el turno con un mensaje breve y claro para el cliente." },
    ],
  }).catch(() => null);

  return (closing?.content ?? "").trim() || FALLBACK_TEXT;
}
