/**
 * Loop del agente: arma system prompt + historial, llama a OpenAI con
 * tool-calling y ejecuta herramientas hasta que el modelo produce el texto
 * final para el cliente. Reemplaza el mega-nodo de n8n.
 */

import { chatCompletion, type ChatMessage } from "../../lib/openai";
import { buildSystemPrompt } from "./agent-prompt";
import { buildKnowledgeHint, trailingUserText } from "./faq-match";
import { toolDefinitionsFor, executeTool, emailDeliveryAvailable, type TurnContext } from "./agent-tools";
import { summarizeCart } from "./cart.service";
import { extractEmail } from "../../lib/email";
import { prisma } from "../../lib/prisma";

const MAX_ITERATIONS = 6;
/** Frases típicas de "no me escribas más" (sin acentos obligatorios). */
const OPT_OUT_RE =
  /\b((ya )?no (me |nos |m)?(escrib|molest|insist|mand|envi)|dej(a|e|en|ar) de (escribir|molestar|insistir|mandar|enviar)|no (me )?(vuelv|vuelva|vuelvan|volver) a escribir|b[oó]rr(a|e|en)(me|nos)|elim[ií]n(a|e|en)(me|nos)|no (me )?interesa[,.! ]+(no|ya no|deja|dejen)|no quiero (que (me )?escrib|recibir|m[aá]s mensajes)|s[aá](c|q)(a|ame|anos|uenme|enme|uennos) de (la|su|tu) lista|^\s*stop\s*$)/i;
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

  // Rubros de CARRITO: inyectar el estado REAL del carrito en el prompt de CADA
  // turno. El historial no incluye los tool_calls de turnos anteriores, así que
  // sin esto el modelo "recuerda" su propia narración (re-agrega ítems, inventa
  // totales) en vez del carrito verdadero.
  const vertical = (ctx.config.business as { vertical?: string }).vertical;
  if (vertical === "RESTAURANT" || vertical === "PHYSICAL_GOODS") {
    try {
      const cart = await summarizeCart(ctx.companyId, ctx.customerId);
      ctx.state.cartText = cart.items.length
        ? cart.items
            .map(
              (it) =>
                `${it.quantity}x ${it.name}${it.modifiers.length ? ` (${it.modifiers.map((m) => m.option).join(", ")})` : ""} — ${cart.symbol} ${(it.unitPrice * it.quantity).toFixed(2)}`,
            )
            .join(" | ") + ` | TOTAL ${cart.totalText}`
        : "vacío";
    } catch {
      ctx.state.cartText = null;
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx.config, ctx.state) },
    ...history,
  ];

  // FAQ determinística: si la consulta coincide claramente con una FAQ/objeción
  // configurada, se inyecta la respuesta al FINAL (recency) con instrucción de
  // usarla. No puede depender solo del modelo (las reglas de herramientas le
  // ganaban a la FAQ y enviaba archivos de otro tema como si fueran lo pedido).
  const inboundText = trailingUserText(history);
  if (inboundText && !inboundText.includes("[el cliente envió una imagen")) {
    const hint = buildKnowledgeHint(ctx.config.products, ctx.state.selectedProductId, inboundText);
    if (hint) {
      messages.push({ role: "system", content: hint });
      console.log(`[agent] FAQ determinística inyectada convo=${ctx.conversationId}`);
    }
  }

  // Opt-out determinista (red de seguridad): si el texto parece pedir que no le
  // escriban más, se recuerda al modelo la regla NO_CONTACTAR. El modelo decide
  // (evita falsos positivos tipo "no me escribas por ahora, te aviso").
  if (inboundText && OPT_OUT_RE.test(inboundText)) {
    messages.push({
      role: "system",
      content:
        "El cliente parece pedir que NO le escriban más. Si es así, respóndele UNA línea breve y respetuosa (sin vender ni preguntar) y llama derivar_humano con motivo NO_CONTACTAR en este mismo turno. Si en realidad solo pospone ('ahora no', 'luego te aviso'), sigue normal.",
    });
    console.log(`[agent] posible opt-out detectado convo=${ctx.conversationId}`);
  }

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

  // Presentación determinista: lead que llega por un anuncio vinculado a un
  // producto (state.selectedProductId sembrado) y abre el chat por primera vez.
  // No puede depender del modelo (pasó en prod: producto en foco perfecto y el
  // modelo saludó genérico sin presentar). Solo primer contacto real: campañas
  // y recordatorios ya tienen mensajes del negocio en el historial y se excluyen.
  const forcePresentation = !forceValidation && shouldForcePresentation(ctx, history);
  if (forcePresentation) {
    console.log(
      `[agent] forzando enviar_ficha (producto en foco ${ctx.state.selectedProductId} sin presentar, primer contacto) convo=${ctx.conversationId}`,
    );
  }

  // Entrega por correo determinista: si el cliente escribió un correo (solo o
  // junto al comprobante: "Enviar a: juan@gmail.com"), eso ES pedir el acceso
  // por email. No puede depender del modelo (pasó en prod: el correo llegó con
  // la captura, el pago se aprobó en 2º plano y el correo nunca salió). Se
  // guarda en el estado (pendingDeliveryEmail) y en la ficha del cliente; si el
  // pago YA está aprobado se fuerza entregar_por_correo en la 1ª iteración; si
  // el comprobante viene en el mismo lote, el pendiente lo cumple la aprobación.
  let forceEmailDelivery = false;
  const inboundEmail = inboundText && emailDeliveryAvailable(ctx.config) ? extractEmail(inboundText) : null;
  // El historial "trailing" puede seguir incluyendo el mensaje del correo si el
  // bot cerró el turno sin texto: si ya se entregó a ese correo y no hay un
  // comprobante nuevo desde entonces, no es un pedido nuevo.
  const emailAlreadyServed =
    !!inboundEmail &&
    ctx.state.lastEmailDeliveredTo === inboundEmail &&
    !!ctx.state.lastEmailDeliveryAt &&
    !(ctx.state.lastReceipt?.at && ctx.state.lastReceipt.at > ctx.state.lastEmailDeliveryAt);
  if (inboundEmail && !emailAlreadyServed) {
    ctx.state.pendingDeliveryEmail = inboundEmail;
    if (!ctx.simulate) {
      await prisma.customer
        .updateMany({ where: { id: ctx.customerId, companyId: ctx.companyId }, data: { email: inboundEmail } })
        .catch(() => null);
    }
    const paid =
      ctx.state.status === "PAGADO" ||
      ctx.state.status === "ENTREGADO" ||
      (Array.isArray(ctx.state.purchasedProductIds) && ctx.state.purchasedProductIds.length > 0);
    if (paid && !forceValidation && !forcePresentation) {
      forceEmailDelivery = true;
      console.log(`[agent] forzando entregar_por_correo (correo ${inboundEmail} con pago aprobado) convo=${ctx.conversationId}`);
    } else {
      messages.push({
        role: "system",
        content:
          `El cliente escribió su correo (${inboundEmail}) para recibir el acceso: el sistema lo guardó como correo pendiente. ` +
          (forceValidation
            ? `Tras validar y entregar en este turno, llama entregar_por_correo con email "${inboundEmail}". Si el pago queda en validación, dile en UNA línea que apenas se confirme le llega también a ese correo (el sistema lo envía solo).`
            : `Si su pago ya está aprobado, llama entregar_por_correo con email "${inboundEmail}". Si aún no pagó, NO envíes nada: dile que apenas confirmes su pago se lo envías también a ese correo y sigue el flujo de pago normal.`),
      });
    }
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await chatCompletion({
      apiKey,
      model: ctx.config.openai.model,
      baseUrl: ctx.config.openai.baseUrl,
      temperature: ctx.config.openai.temperature,
      messages,
      tools: toolDefinitionsFor(ctx.config),
      toolChoice:
        i === 0 && forceValidation
          ? { type: "function", function: { name: "validar_pago" } }
          : i === 0 && forcePresentation
            ? { type: "function", function: { name: "enviar_ficha" } }
            : i === 0 && forceEmailDelivery
              ? { type: "function", function: { name: "entregar_por_correo" } }
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
        (ctx.toolsCalled ??= []).push(call.function.name);
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
    baseUrl: ctx.config.openai.baseUrl,
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
/**
 * ¿Forzar la presentación del producto en foco? Solo el caso "lead de anuncio
 * recién llegado": hay selectedProductId sembrado (catálogo de anuncios), ese
 * producto NUNCA se presentó, y es el primer contacto real del chat (sin
 * mensajes previos del negocio — campañas/recordatorios quedan fuera).
 */
function shouldForcePresentation(ctx: TurnContext, history: ChatMessage[]): boolean {
  const productId = ctx.state.selectedProductId;
  if (!productId) return false;
  if ((ctx.state.presentedProductIds ?? []).includes(productId)) return false;
  if (history.some((m) => m.role === "assistant")) return false;
  // El producto debe existir en el catálogo activo del bot (si fue desactivado,
  // dejar que el modelo maneje el turno con normalidad).
  if (!ctx.config.products.some((p) => p.id === productId)) return false;
  return true;
}

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
