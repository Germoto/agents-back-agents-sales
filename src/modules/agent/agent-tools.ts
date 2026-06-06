/**
 * Herramientas (tool-calling) del agente. Cada una mapea a lógica/Prisma ya
 * existente; el modelo decide cuándo usarlas. Las que envían algo al cliente
 * (multimedia, métodos de pago, entrega) empujan mensajes al `outbox` que el
 * runtime vacía en orden por WhatsApp; el resto sólo devuelven datos al modelo.
 */

import { prisma } from "../../lib/prisma";
import type { ToolDefinition } from "../../lib/openai";
import type { getBotConfig } from "../bot/bot.service";
import type { ConversationState } from "./conversation.service";
import { mediaKindFor } from "./outbound";
import {
  addToCart,
  removeFromCart,
  summarizeCart,
  renderCartText,
  checkoutCart,
} from "./cart.service";
import {
  matchPayments,
  claimPayment,
  updatePaymentStatus,
} from "../public-payments/public-payments.service";

type BotConfig = Awaited<ReturnType<typeof getBotConfig>>;
type BotProduct = BotConfig["products"][number];

export interface OutboxMessage {
  kind: "text" | "media";
  text?: string;
  mediaUrl?: string;
  mediaKind?: "image" | "document" | "video" | "audio";
  caption?: string;
}

export interface TurnContext {
  companyId: string;
  customerId: string;
  conversationId: string;
  customerPhone: string;
  config: BotConfig;
  state: ConversationState;
  outbox: OutboxMessage[];
  /** recordatorios a crear al cerrar el turno: {type, minutes, body} */
  reminders: Array<{ type: string; minutes: number; body: string }>;
}

// --------------------------------------------------------------------------
// Matching de producto (porta el matcher del workflow n8n: exacto/alias/fuzzy)
// --------------------------------------------------------------------------
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1], dp[j]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function matchProduct(query: string, products: BotProduct[]): BotProduct | null {
  const q = normalize(query);
  if (!q) return null;

  // 1) ordinal: "1", "2", "uno", "dos"...
  const ordinals: Record<string, number> = {
    "1": 0, uno: 0, primero: 0, primera: 0,
    "2": 1, dos: 1, segundo: 1, segunda: 1,
    "3": 2, tres: 2, tercero: 2, tercera: 2,
    "4": 3, cuatro: 3, "5": 4, cinco: 4,
  };
  if (q in ordinals && products[ordinals[q]]) return products[ordinals[q]];

  // 2) exacto por slug/name/alias
  for (const p of products) {
    const cands = [p.slug, p.name, ...(p.aliases ?? [])].map(normalize);
    if (cands.includes(q)) return p;
  }

  // 3) substring por palabra completa
  for (const p of products) {
    const cands = [p.name, ...(p.aliases ?? [])].map(normalize);
    for (const c of cands) {
      if (!c) continue;
      if (q.includes(c) && c.length >= 4) return p;
      if (c.includes(q) && q.length >= 4) return p;
    }
  }

  // 4) fuzzy (Levenshtein) para typos
  let best: { p: BotProduct; score: number } | null = null;
  for (const p of products) {
    const cands = [p.name, ...(p.aliases ?? [])].map(normalize).filter((c) => c.length >= 4);
    for (const c of cands) {
      const maxLen = Math.max(c.length, q.length);
      if (maxLen === 0) continue;
      const sim = 1 - levenshtein(q, c) / maxLen;
      if (sim >= 0.72 && (!best || sim > best.score)) best = { p, score: sim };
    }
  }
  return best?.p ?? null;
}

function findProductById(ctx: TurnContext, productId: string): BotProduct | undefined {
  return ctx.config.products.find((p) => p.id === productId || p.slug === productId);
}

// --------------------------------------------------------------------------
// Definiciones de herramientas (schema para OpenAI)
// --------------------------------------------------------------------------
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "buscar_producto",
      description:
        "Identifica un producto del catálogo a partir de lo que escribe el cliente (nombre, alias, número de opción o texto con errores). Devuelve la ficha para que puedas responder. Úsalo cuando el cliente mencione o pregunte por un producto.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", description: "Texto del cliente para identificar el producto" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_multimedia",
      description:
        "Envía al cliente los archivos (imágenes, PDF, video) de un producto. Úsalo cuando pida fotos, ficha, material o pruebas visuales.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: {
          productId: { type: "string", description: "id del producto" },
          kind: { type: "string", enum: ["image", "pdf", "video", "all"], description: "tipo de archivo; 'all' envía todos" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agregar_carrito",
      description: "Agrega un producto al carrito del cliente. Úsalo cuando quiera comprar uno o varios productos.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: {
          productId: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_carrito",
      description: "Devuelve el contenido y total actual del carrito del cliente.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "quitar_carrito",
      description: "Quita un producto del carrito.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: { productId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_metodos_pago",
      description:
        "Envía al cliente los métodos de pago y el monto a pagar (del carrito o del producto seleccionado). Úsalo SOLO cuando exprese intención clara de pagar/comprar/activar.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "validar_pago",
      description:
        "Valida automáticamente el pago del cliente buscando un comprobante recibido que coincida por nombre del titular y monto. Devuelve si quedó APROBADO. Úsalo cuando el cliente diga que ya pagó e indique el nombre del titular de su Yape/Plin.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["payerName"],
        properties: {
          payerName: { type: "string", description: "Nombre del titular que aparece en el Yape/Plin del cliente" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "entregar_producto",
      description:
        "Entrega el/los producto(s) digital(es) comprados (envía enlace e instrucciones). Solo funciona si hay un pago APROBADO para este cliente.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_recordatorio",
      description:
        "Programa un mensaje de seguimiento futuro (abandono de carrito, dejado en visto, timer de oferta, post-venta).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["type", "minutes", "message"],
        properties: {
          type: { type: "string", enum: ["ABANDONED_CART", "LEFT_ON_READ", "OFFER_COUNTDOWN", "POST_SALE", "CUSTOM"] },
          minutes: { type: "integer", minimum: 1, description: "minutos desde ahora para enviarlo" },
          message: { type: "string", description: "texto del recordatorio" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "derivar_humano",
      description: "Pausa el bot y avisa a un asesor humano. Úsalo si el cliente lo pide o hay un problema que no puedes resolver.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: { reason: { type: "string" } },
      },
    },
  },
];

// --------------------------------------------------------------------------
// Ejecutor de herramientas
// --------------------------------------------------------------------------
export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: TurnContext,
): Promise<string> {
  switch (name) {
    case "buscar_producto": {
      const product = matchProduct(String(args.query ?? ""), ctx.config.products);
      if (!product) return JSON.stringify({ found: false, hint: "No se identificó un producto. Ofrece el catálogo." });
      ctx.state.selectedProductId = product.id;
      return JSON.stringify({
        found: true,
        product: {
          id: product.id,
          name: product.name,
          price: product.priceText ?? product.price,
          regularPrice: product.regularPriceText,
          productType: product.productType,
          shortDescription: product.shortDescription,
          fullDescription: product.fullDescription,
          benefits: product.benefits,
          includes: product.includes,
          bonuses: product.bonuses,
          faqs: product.faqs,
          objections: product.objections,
          hasMedia: (product.files?.length ?? 0) > 0,
        },
      });
    }

    case "enviar_multimedia": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      const wanted = String(args.kind ?? "all");
      const files = (product.files ?? []).filter((f) => {
        if (wanted === "all") return true;
        if (wanted === "pdf") return f.type === "pdf";
        return f.type === wanted;
      });
      if (!files.length) return JSON.stringify({ ok: false, error: "el producto no tiene multimedia de ese tipo" });
      for (const f of files.slice(0, 6)) {
        ctx.outbox.push({
          kind: "media",
          mediaUrl: f.url,
          mediaKind: mediaKindFor(f.type),
          caption: f.description || undefined,
        });
      }
      return JSON.stringify({ ok: true, sent: Math.min(files.length, 6) });
    }

    case "agregar_carrito": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      const qty = Math.max(1, Number(args.quantity ?? 1));
      const summary = await addToCart(ctx.companyId, ctx.customerId, product.id, qty);
      ctx.state.selectedProductId = product.id;
      return JSON.stringify({ ok: true, cart: summary.items, total: summary.totalText });
    }

    case "ver_carrito": {
      const summary = await summarizeCart(ctx.companyId, ctx.customerId);
      return JSON.stringify({ items: summary.items, total: summary.totalText });
    }

    case "quitar_carrito": {
      const summary = await removeFromCart(ctx.companyId, ctx.customerId, String(args.productId ?? ""));
      return JSON.stringify({ ok: true, items: summary.items, total: summary.totalText });
    }

    case "enviar_metodos_pago": {
      if (!ctx.config.payment.enabled || !ctx.config.payment.methods.length) {
        return JSON.stringify({ ok: false, error: "pagos no configurados" });
      }
      const cart = await summarizeCart(ctx.companyId, ctx.customerId);
      let amountText = cart.totalText;
      if (!cart.items.length && ctx.state.selectedProductId) {
        const p = findProductById(ctx, ctx.state.selectedProductId);
        amountText = p?.priceText ?? p?.price ?? amountText;
      }
      const methods = ctx.config.payment.methods
        .map((m) => `• ${m.method}: *${m.number}* (titular: ${m.holder})`)
        .join("\n");
      const text =
        `El monto a pagar es: *${amountText}*\n\n` +
        `Puedes pagar con:\n${methods}\n\n` +
        `Cuando pagues, respóndeme con el *nombre del titular* que aparece en tu Yape/Plin para validar tu pago automáticamente.`;
      ctx.outbox.push({ kind: "text", text });
      ctx.state.status = "ESPERANDO_PAGO";
      ctx.state.lastPaymentPromptAt = new Date().toISOString();
      return JSON.stringify({ ok: true, amount: amountText });
    }

    case "validar_pago": {
      const payerName = String(args.payerName ?? "").trim();
      if (!payerName) return JSON.stringify({ ok: false, error: "falta el nombre del titular" });

      // Monto esperado: total del carrito o precio del producto seleccionado
      const cart = await summarizeCart(ctx.companyId, ctx.customerId);
      let expected: number | undefined = cart.total > 0 ? cart.total : undefined;
      if (expected === undefined && ctx.state.selectedProductId) {
        const p = findProductById(ctx, ctx.state.selectedProductId);
        const n = Number(String(p?.price ?? "").replace(/[^0-9.]/g, ""));
        if (Number.isFinite(n) && n > 0) expected = n;
      }

      const candidates = await matchPayments(ctx.companyId, {
        payerName,
        amountPaid: expected,
        limit: 5,
      } as any);

      const top = candidates[0];
      // Aprobar si hay coincidencia razonable (monto o nombre)
      if (!top || (top as any).matchScore < 30) {
        ctx.state.status = "ESPERANDO_VALIDACION";
        return JSON.stringify({
          ok: false,
          approved: false,
          reason: "No se encontró un comprobante que coincida todavía. Pide al cliente que espere un momento o que envíe la captura del pago.",
        });
      }

      const productIds = cart.productIds.length
        ? cart.productIds
        : ctx.state.selectedProductId
        ? [ctx.state.selectedProductId]
        : [];

      try {
        await claimPayment(ctx.companyId, (top as any).id, { claimedBy: "agent", claimTtlSeconds: 120 } as any);
        await updatePaymentStatus(ctx.companyId, (top as any).id, {
          status: "APROBADO",
          validationMode: "AUTO",
          matchScore: (top as any).matchScore,
          matchStrategy: ((top as any).matchReasons ?? []).join("+") || "agent_auto",
          matchedPayerNameInput: payerName,
          customerPhone: ctx.customerPhone,
          productIds,
        } as any);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          approved: false,
          reason: "El comprobante no pudo cerrarse automáticamente (puede estar en revisión). Informa que un asesor lo confirmará en breve.",
        });
      }

      if (cart.items.length) await checkoutCart(ctx.companyId, ctx.customerId, cart.totalText);
      ctx.state.status = "PAGADO";
      return JSON.stringify({ ok: true, approved: true, note: "Pago aprobado. Ahora entrega el producto con entregar_producto." });
    }

    case "entregar_producto": {
      // Verificar que exista un pago aprobado reciente para este cliente
      const approved = await prisma.paymentReceipt.findFirst({
        where: { companyId: ctx.companyId, customerId: ctx.customerId, status: "APROBADO" },
        orderBy: { validatedAt: "desc" },
        select: { id: true, productIds: true, productId: true },
      });
      if (!approved) {
        return JSON.stringify({ ok: false, error: "No hay un pago aprobado para este cliente. No entregues nada todavía." });
      }

      const ids = approved.productIds?.length
        ? approved.productIds
        : approved.productId
        ? [approved.productId]
        : ctx.state.selectedProductId
        ? [ctx.state.selectedProductId]
        : [];

      const delivered: string[] = [];
      for (const id of ids) {
        const p = findProductById(ctx, id);
        if (!p || p.productType !== "digital" || !p.digitalDelivery?.link) continue;
        ctx.outbox.push({
          kind: "text",
          text:
            `✅ *${p.name}*\n\nAcceso:\n${p.digitalDelivery.link}\n\n` +
            (p.digitalDelivery.instructions ? `Instrucciones:\n${p.digitalDelivery.instructions}` : ""),
        });
        delivered.push(p.name);
      }
      if (!delivered.length) {
        return JSON.stringify({ ok: false, error: "No se encontró entrega digital configurada para el producto pagado." });
      }
      ctx.state.status = "ENTREGADO";
      // Recordatorio post-venta a las 24h
      ctx.reminders.push({
        type: "POST_SALE",
        minutes: 60 * 24,
        body: `Hola 👋 ¿Cómo te fue con ${delivered.join(", ")}? Si necesitas ayuda, escríbeme. ¿Te muestro algo más del catálogo?`,
      });
      return JSON.stringify({ ok: true, delivered });
    }

    case "agendar_recordatorio": {
      const minutes = Math.max(1, Number(args.minutes ?? 60));
      ctx.reminders.push({
        type: String(args.type ?? "CUSTOM"),
        minutes,
        body: String(args.message ?? ""),
      });
      return JSON.stringify({ ok: true, scheduledInMinutes: minutes });
    }

    case "derivar_humano": {
      ctx.state.status = "ASESOR_HUMANO";
      ctx.state.pendingAction = `HUMAN: ${String(args.reason ?? "")}`;
      return JSON.stringify({ ok: true, note: "Conversación marcada para asesor humano. Despídete amablemente indicando que un asesor continuará." });
    }

    default:
      return JSON.stringify({ ok: false, error: `herramienta desconocida: ${name}` });
  }
}
