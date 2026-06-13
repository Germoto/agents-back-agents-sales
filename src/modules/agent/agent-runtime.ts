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
  // En modo FLOW buildBotConfig no exige apiKey; el agente IA sí la necesita.
  const apiKey = ctx.config.openai.apiKey;
  if (!apiKey) throw new Error("Falta openaiApiKey para esta empresa");

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx.config, ctx.state) },
    ...history,
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await chatCompletion({
      apiKey,
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

    // Sin tool_calls => texto final para el cliente. Si el modelo no agrega texto
    // pero alguna herramienta ya envió contenido al cliente (outbox), devolvemos
    // "" para NO mandar un segundo mensaje redundante. El FALLBACK solo aplica
    // cuando no se envió nada en todo el turno — y NUNCA si el comprobante del
    // cliente ya se gestionó por fuera (auto-validación), para no tapar ese
    // mensaje con el genérico "tuve un problema".
    const final = (res.content ?? "").trim();
    // NUNCA mandes el genérico "tuve un problema" cuando el último mensaje del
    // cliente fue una IMAGEN (el modelo no la ve; el comprobante se gestiona
    // aparte), ni en contexto de pago: taparía la validación.
    const recent = (iso?: string | null) => (iso ? Date.now() - new Date(iso).getTime() < 90 * 1000 : false);
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const lastWasMedia =
      typeof lastUser?.content === "string" && lastUser.content.includes("[el cliente envió una imagen");
    const paymentCtx = recent(ctx.state.receiptAutoHandledAt) || recent(ctx.state.lastReceipt?.at);
    return final || (ctx.outbox.length || paymentCtx || lastWasMedia ? "" : FALLBACK_TEXT);
  }

  // Si agotó iteraciones, fuerza un cierre en texto sin herramientas
  const closing = await chatCompletion({
    apiKey,
    model: ctx.config.openai.model,
    temperature: ctx.config.openai.temperature,
    messages: [
      ...messages,
      { role: "user", content: "Cierra el turno con un mensaje breve y claro para el cliente." },
    ],
  }).catch(() => null);

  return (closing?.content ?? "").trim() || FALLBACK_TEXT;
}
