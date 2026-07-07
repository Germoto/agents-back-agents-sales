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

  // Validación determinista: si la visión ya leyó un CÓDIGO de seguridad, la
  // validación no puede depender de que el modelo decida llamar la herramienta
  // (pasó en prod: comprobante perfecto en el estado y el modelo respondió un
  // genérico sin validar). Se fuerza validar_pago en la primera iteración; el
  // resto del turno sigue normal con el resultado del tool.
  const forceValidation = shouldForceValidation(ctx);
  if (forceValidation) {
    ctx.state.receiptAutoHandledAt = ctx.state.lastReceipt?.at ?? new Date().toISOString();
    console.log(
      `[agent] forzando validar_pago (comprobante leído cód=${ctx.state.lastReceipt?.securityCode}) convo=${ctx.conversationId}`,
    );
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await chatCompletion({
      apiKey,
      model: ctx.config.openai.model,
      temperature: ctx.config.openai.temperature,
      messages,
      tools: TOOL_DEFINITIONS,
      toolChoice:
        i === 0 && forceValidation
          ? { type: "function", function: { name: "validar_pago" } }
          : "auto",
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
    return final || (suppressFallback(ctx, history) ? "" : FALLBACK_TEXT);
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

  return (closing?.content ?? "").trim() || (suppressFallback(ctx, history) ? "" : FALLBACK_TEXT);
}

/**
 * ¿Corresponde forzar validar_pago en este turno? Solo el caso Yape con CÓDIGO
 * de seguridad leído por visión (con código la validación no necesita nada del
 * modelo; Plin/sin código sigue el flujo conversacional). Condiciones:
 * comprobante fresco (<10 min), aún no forzado para ESTE comprobante
 * (receiptAutoHandledAt marca el `at` ya gestionado) y venta no cerrada/derivada.
 */
function shouldForceValidation(ctx: TurnContext): boolean {
  const r = ctx.state.lastReceipt;
  if (!r?.securityCode || !r.at) return false;
  if (Date.now() - new Date(r.at).getTime() > 10 * 60 * 1000) return false;
  if (ctx.state.receiptAutoHandledAt === r.at) return false;
  const status = ctx.state.status ?? "";
  if (status === "PAGADO" || status === "ENTREGADO" || status === "ASESOR_HUMANO") return false;
  return true;
}

/**
 * NUNCA mandar el genérico "tuve un problema" cuando el último mensaje del cliente
 * fue una IMAGEN (el modelo no la ve; el comprobante se gestiona aparte) o cuando
 * se acaba de leer/auto-gestionar un comprobante: taparía la validación del pago.
 */
function suppressFallback(ctx: TurnContext, history: ChatMessage[]): boolean {
  if (ctx.outbox.length) return true;
  const recent = (iso?: string | null) => (iso ? Date.now() - new Date(iso).getTime() < 90 * 1000 : false);
  if (recent(ctx.state.receiptAutoHandledAt) || recent(ctx.state.lastReceipt?.at)) return true;
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  return typeof lastUser?.content === "string" && lastUser.content.includes("[el cliente envió una imagen");
}
