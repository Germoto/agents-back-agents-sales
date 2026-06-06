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
      if (p.productType === "physical" && p.physicalDelivery) {
        const d = p.physicalDelivery;
        const env: string[] = [];
        if (d.deliveryCost) env.push(`costo envío: ${d.deliveryCost}`);
        if (d.deliveryTime) env.push(`tiempo: ${d.deliveryTime}`);
        if (d.pickupAvailable) env.push("recojo disponible");
        if (d.requiresAddress === false) env.push("no requiere dirección");
        if (env.length) parts.push(`   envío: ${env.join(" · ")}`);
        if (d.deliveryAreas?.length) parts.push(`   zonas de envío: ${d.deliveryAreas.slice(0, 8).join(", ")}`);
      }
      if (p.variants?.length)
        parts.push(`   variantes: ${p.variants.map((v) => `${v.name} (${v.options.join("/")})`).join(" | ")}`);
      if (p.attributes && typeof p.attributes === "object") {
        const attrs = Object.entries(p.attributes as Record<string, unknown>)
          .filter(([, v]) => v != null && String(v).trim())
          .map(([k, v]) => `${k}: ${v}`);
        if (attrs.length) parts.push(`   atributos: ${attrs.join(" · ")}`);
      }
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

// Guía de comportamiento según el rubro del negocio (Company.vertical).
function verticalGuidance(vertical: string | undefined): string {
  switch (vertical) {
    case "RESTAURANT":
      return "Rubro RESTAURANTE: el catálogo son platos/combos. Ayuda a armar el pedido (varios ítems con cantidades en el carrito), sugiere acompañamientos/bebidas (upsell), considera tiempo de preparación y zona de entrega. Para delivery toma dirección y registra el pedido; para recojo en local indícalo. Sé rápido y apetitoso.";
    case "STREAMER":
      return "Rubro STREAMER/SUSCRIPCIONES: vendes accesos, membresías o suscripciones (digitales). Explica qué incluye y la duración, cobra y, tras validar el pago, entrega el acceso. Ofrece renovaciones y planes superiores.";
    case "SERVICE":
      return "Rubro SERVICIOS: vendes servicios (citas, asesorías, reservas). Explica alcance, duración y modalidad; coordina fecha/horario en texto y deja constancia en notas. Cobra según el modo configurado. Si requiere agenda, deriva o confirma con un asesor.";
    case "PHYSICAL_GOODS":
      return "Rubro PRODUCTOS FÍSICOS: prioriza catálogo, variantes (talla/color), stock y envío. Cierra con registrar_pedido tras tomar datos de entrega.";
    case "INFOPRODUCT":
      return "Rubro INFOPRODUCTOS: cursos, ebooks y accesos digitales. Resuelve dudas, maneja objeciones, cobra y entrega el acceso tras validar el pago.";
    default:
      return "Adapta el comportamiento al tipo de cada producto (digital o físico) y a la base de conocimiento configurada.";
  }
}

export function buildSystemPrompt(config: BotConfig, state: ConversationState): string {
  const rules = Array.isArray(config.agent.rules) ? config.agent.rules : [];
  const paymentMode = config.payment.paymentMode; // before_delivery | cash_on_delivery | manual
  const vertical = (config.business as { vertical?: string }).vertical;

  return [
    config.agent.basePrompt,
    "",
    `Negocio: ${config.business.name}. Estilo comercial: ${config.agent.salesStyle}.`,
    `Rubro del negocio: ${vertical ?? "INFOPRODUCT"}. ${verticalGuidance(vertical)}`,
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
    "- Para validar un pago, primero pide y usa el nombre del titular que aparece en el Yape/Plin del cliente y llama a validar_pago. Solo entrega el producto digital (entregar_producto) cuando validar_pago confirme APROBADO.",
    "- Productos DIGITALES: informa, cobra, valida el pago y entrega el acceso. Nunca pidas dirección ni datos de envío.",
    "- Productos FÍSICOS: informa, ayuda a cerrar y pide los datos de entrega (nombre de quien recibe, dirección completa, referencia, cantidad y variante si el producto tiene variantes). Valida la dirección contra las zonas de envío configuradas; si está fuera de zona, dilo y ofrece alternativas (recojo si está disponible). Luego registra el pedido con registrar_pedido. Nunca envíes enlaces digitales para un físico.",
    `- Modo de pago del negocio: *${paymentMode}*. before_delivery = cobra y valida el pago (enviar_metodos_pago + validar_pago) ANTES de registrar el pedido. cash_on_delivery = toma los datos y registra el pedido (paga contra entrega), sin cobrar antes. manual = registra el pedido y coordina el pago con un asesor.`,
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
