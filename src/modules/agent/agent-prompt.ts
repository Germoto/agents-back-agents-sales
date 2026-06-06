/**
 * Construye el system prompt del agente desde la config del tenant (bot/config).
 *
 * A diferencia de n8n (regex + JSON-mode), aqui el modelo decide via tool-calling.
 * Conservamos las reglas DURAS del negocio (no inventar, no revelar link antes de
 * pago, digital vs fisico) pero la interpretacion del cliente la hace el modelo,
 * no ramas fijas. Eso elimina la rigidez ante mensajes fuera de guion.
 */

import type { getBotConfig } from "../bot/bot.service";
import type { ConversationState } from "./conversation.service";

type BotConfig = Awaited<ReturnType<typeof getBotConfig>>;

function renderCatalog(products: BotConfig["products"]): string {
  if (!products.length) return "(sin productos activos)";
  return products
    .map((p, i) => {
      const parts = [
        `${i + 1}. [${p.id}] ${p.name} — ${p.priceText ?? p.price}${
          p.regularPriceText ? ` (antes ${p.regularPriceText})` : ""
        } · ${p.productType}`,
        `   ${p.shortDescription}`,
      ];
      if (p.aliases?.length) parts.push(`   alias: ${p.aliases.join(", ")}`);
      if (p.benefits?.length) parts.push(`   beneficios: ${p.benefits.slice(0, 5).join("; ")}`);
      if (p.includes?.length) parts.push(`   incluye: ${p.includes.slice(0, 5).join("; ")}`);
      if (p.faqs?.length)
        parts.push(`   faq: ${p.faqs.slice(0, 4).map((f) => `${f.question} -> ${f.answer}`).join(" | ")}`);
      if (p.objections?.length)
        parts.push(
          `   objeciones: ${p.objections.slice(0, 4).map((o) => `${o.question} -> ${o.answer}`).join(" | ")}`,
        );
      const mediaCount = p.files?.length ?? 0;
      if (mediaCount) parts.push(`   multimedia disponible: ${mediaCount} archivo(s)`);
      return parts.join("\n");
    })
    .join("\n\n");
}

function renderPaymentMethods(payment: BotConfig["payment"]): string {
  if (!payment.enabled || !payment.methods.length) return "(pagos no configurados)";
  return payment.methods
    .map((m) => `- ${m.method}: ${m.number} (titular: ${m.holder})`)
    .join("\n");
}

export function buildSystemPrompt(config: BotConfig, state: ConversationState): string {
  const rules = Array.isArray(config.agent.rules) ? config.agent.rules : [];

  return [
    config.agent.basePrompt,
    "",
    `Negocio: ${config.business.name}. Estilo comercial: ${config.agent.salesStyle}.`,
    "",
    "Reglas del negocio configuradas por el dueño:",
    ...rules.map((r) => `- ${r}`),
    "",
    "Reglas DURAS (no negociables):",
    "- Responde en español, breve y natural, como un buen vendedor por WhatsApp.",
    "- Usa SOLO el catálogo entregado. No inventes productos, precios, stock, bonos, garantías, métodos de pago ni zonas de envío. Si un dato no está, dilo y ofrece derivar a un asesor.",
    "- Puedes ofrecer y vender MÚLTIPLES productos del catálogo. Usa el carrito si el cliente quiere más de uno.",
    "- Responde preguntas abiertas usando la base de conocimiento del producto (descripción, beneficios, incluye, bonos, faq, objeciones). No te limites a un guion: si el cliente pregunta algo, contéstalo.",
    "- Para mostrar imágenes/PDF/video usa la herramienta enviar_multimedia. Para dar métodos de pago usa enviar_metodos_pago (nunca escribas números de pago en texto libre).",
    "- NUNCA reveles el enlace de entrega digital antes de que el pago esté APROBADO. Puedes explicar cómo es la entrega sin dar el link.",
    "- Para validar un pago, primero pide y usa el nombre del titular que aparece en el Yape/Plin del cliente y llama a validar_pago. Solo entrega el producto (entregar_producto) cuando validar_pago confirme APROBADO.",
    "- Si el cliente se enfría, deja en visto o tiene un carrito sin pagar, puedes programar un recordatorio con agendar_recordatorio.",
    "- Si pide hablar con una persona o hay un problema que no puedes resolver, usa derivar_humano.",
    "",
    "Catálogo disponible:",
    renderCatalog(config.products),
    "",
    "Métodos de pago configurados:",
    renderPaymentMethods(config.payment),
    "",
    `Estado actual de la conversación: ${JSON.stringify({
      status: state.status ?? "NUEVO",
      selectedProductId: state.selectedProductId ?? null,
      pendingAction: state.pendingAction ?? null,
    })}`,
    "",
    "Tu respuesta final (texto sin herramientas) es lo que el cliente leerá como cierre del turno. Las herramientas ejecutan acciones y/o envían adjuntos; después de usarlas, redacta SIEMPRE un mensaje final claro para el cliente.",
  ].join("\n");
}
