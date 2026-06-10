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
import { createAgentOrder, createOrderFromCart } from "./order.service";
import { createBooking } from "./booking.service";

type BotConfig = Awaited<ReturnType<typeof getBotConfig>>;
type BotProduct = BotConfig["products"][number];

export interface OutboxMessage {
  kind: "text" | "media";
  text?: string;
  mediaUrl?: string;
  mediaKind?: "image" | "document" | "video" | "audio";
  caption?: string;
  /** nombre original del archivo (documentos): se usa como document_name en SMS Tools. */
  fileName?: string;
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
  /** avisos a enviar al admin al cerrar el turno (pedidos, handoff, etc.) */
  adminNotices: string[];
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

/** Ficha customer-facing de un producto con los campos configurados (paso 3). */
function renderProductFicha(p: BotProduct): string {
  const price = p.priceText ?? p.price;
  const priceLine = p.regularPriceText
    ? `💰 *${price}*  ~antes ${p.regularPriceText}~`
    : `💰 *${price}*`;
  const parts: string[] = [`*${p.name}*`];
  const desc = (p.fullDescription || p.shortDescription || "").trim();
  if (desc) parts.push(desc);
  if (p.benefits?.length) parts.push(`*Lo que logras:*\n${p.benefits.join("\n")}`);
  if (p.includes?.length) parts.push(`*Incluye:*\n${p.includes.join("\n")}`);
  if (p.bonuses?.length) parts.push(`*Bonos:*\n${p.bonuses.join("\n")}`);
  parts.push(priceLine);
  return parts.join("\n\n");
}

/** Catálogo customer-facing (sin ids/alias), agrupado por categoría si existe. */
function renderCustomerCatalog(products: BotProduct[]): string {
  const line = (p: BotProduct) => {
    const price = p.priceText ?? p.price;
    const desc = p.shortDescription ? ` — ${p.shortDescription}` : "";
    return `• *${p.name}* (${price})${desc}`;
  };
  const hasCat = products.some((p) => p.category && p.category.trim());
  if (!hasCat) return products.map(line).join("\n");
  const groups = new Map<string, BotProduct[]>();
  for (const p of products) {
    const c = p.category?.trim() || "Otros";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(p);
  }
  const sections: string[] = [];
  for (const [cat, items] of groups) sections.push(`*${cat}*\n${items.map(line).join("\n")}`);
  return sections.join("\n\n");
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
      name: "enviar_ficha",
      description:
        "Envía al cliente la ficha del producto con su descripción, beneficios, qué incluye y bonos (tal como están configurados). Úsalo para PRESENTAR un producto cuando el cliente lo elige o pregunta por él, ANTES de enviar la multimedia.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: { productId: { type: "string", description: "id del producto" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_catalogo",
      description:
        "Envía al cliente el catálogo/lista de productos (agrupado por categoría). Úsalo cuando el cliente salude por primera vez, pregunte qué vendes / qué tienes, o pida ver opciones.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_multimedia",
      description:
        "Envía al cliente los archivos (imágenes, PDF, video, audio u otros) de un producto. Úsalo cuando pida fotos, una muestra, ficha o material; también cuando el cliente RE-pida un archivo que ya enviaste (reenvíaselo) o cuando su consulta se relacione con un archivo concreto: en ese caso envía SOLO ese archivo pasando su id en `fileIds`. Cada archivo y su descripción están en el catálogo del producto.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: {
          productId: { type: "string", description: "id del producto" },
          fileIds: {
            type: "array",
            items: { type: "string" },
            description: "ids de los archivos concretos a enviar (de la lista de multimedia del producto). Úsalo para enviar SOLO el/los archivo(s) que el cliente pide o que se relacionan con su consulta; si lo pasas, se envían esos sin importar si ya se enviaron antes.",
          },
          kind: { type: "string", enum: ["image", "pdf", "video", "audio", "all"], description: "filtra por tipo cuando NO indicas fileIds; 'all' envía todos" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agregar_carrito",
      description:
        "Agrega un producto al carrito. Úsalo cuando quiera comprar uno o varios. Para rubros con modificadores (restaurante), pasa los modificadores elegidos (tamaño, extras); el precio de la línea se ajusta con sus deltas.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: {
          productId: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
          modifiers: {
            type: "array",
            description: "Modificadores elegidos (ej. {group:'Tamaño', option:'Familiar'}). Solo si el producto los define.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["group", "option"],
              properties: { group: { type: "string" }, option: { type: "string" } },
            },
          },
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
      name: "registrar_pedido",
      description:
        "Registra un pedido de un producto FÍSICO una vez que tienes los datos de entrega. Úsalo cuando el cliente confirme la compra de un físico y te haya dado nombre y dirección (y, si aplica, la variante elegida). Para físicos con pago anticipado, valida el pago ANTES de registrar.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "customerName", "address"],
        properties: {
          productId: { type: "string" },
          customerName: { type: "string", description: "Nombre de quien recibe" },
          address: { type: "string", description: "Dirección completa de entrega" },
          reference: { type: "string", description: "Referencia o indicaciones del domicilio" },
          quantity: { type: "integer", minimum: 1 },
          variant: { type: "string", description: "Variante/opción elegida (talla, color, etc.) si aplica" },
          notes: { type: "string", description: "Notas adicionales del pedido" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "registrar_pedido_carrito",
      description:
        "Registra UN pedido con todo el carrito (ej. restaurante: varios platos con sus modificadores). Úsalo cuando el cliente confirme el pedido y tengas los datos de entrega. Para pago anticipado, valida el pago ANTES.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["customerName", "address"],
        properties: {
          customerName: { type: "string", description: "Nombre de quien recibe" },
          address: { type: "string", description: "Dirección de entrega (o 'recojo en local')" },
          reference: { type: "string", description: "Referencia del domicilio" },
          notes: { type: "string", description: "Notas del pedido (ej. sin picante, tocar timbre)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_servicio",
      description:
        "Registra una reserva de un SERVICIO (rubro servicios) cuando el cliente acepta y da un horario preferido. Guarda el horario tal cual lo dice el cliente; un asesor confirmará el detalle.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "requestedText"],
        properties: {
          productId: { type: "string", description: "id del servicio" },
          requestedText: { type: "string", description: "Fecha/hora preferida tal como la dijo el cliente (ej. 'sábado 4pm')" },
          modality: { type: "string", description: "presencial | online (si aplica)" },
          notes: { type: "string", description: "Detalles o requisitos del cliente" },
        },
      },
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
          media: (product.files ?? []).slice(0, 8).map((f) => ({
            id: f.id,
            type: f.type,
            description: f.description ?? null,
          })),
        },
      });
    }

    case "enviar_ficha": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      ctx.state.selectedProductId = product.id;
      const presented = Array.isArray(ctx.state.presentedProductIds) ? ctx.state.presentedProductIds : [];
      if (presented.includes(product.id)) {
        return JSON.stringify({ ok: true, alreadySent: true, nota: "Ya enviaste la ficha de este producto en esta conversación. NO la reenvíes; responde la consulta del cliente directamente con la base de conocimiento (faq, objeciones, descripción)." });
      }
      ctx.state.presentedProductIds = [...presented, product.id];
      ctx.outbox.push({ kind: "text", text: renderProductFicha(product) });
      return JSON.stringify({ ok: true, sent: true, nota: "Ya envié la ficha (descripción, beneficios, incluye, bonos, precio) al cliente. NO la repitas en tu texto final." });
    }

    case "enviar_catalogo": {
      const products = ctx.config.products;
      if (!products.length) return JSON.stringify({ ok: false, error: "no hay productos en el catálogo" });
      const body = renderCustomerCatalog(products);
      ctx.outbox.push({
        kind: "text",
        text: `📋 *${ctx.config.business.name}* — esto es lo que tenemos:\n\n${body}\n\n¿Cuál te interesa? Te cuento más. 😊`,
      });
      return JSON.stringify({ ok: true, count: products.length, sent: true, nota: "Ya envié el catálogo al cliente. NO repitas la lista en tu texto final; deja el texto vacío o cierra con una sola frase breve." });
    }

    case "enviar_multimedia": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      const allFiles = product.files ?? [];

      // Envío TARGETED: el modelo indica archivos concretos (los que el cliente
      // pide o que se relacionan con su consulta). Se envían siempre, sin guard
      // (cubre reenvíos explícitos y el "manda solo ese archivo").
      const requestedIds = Array.isArray(args.fileIds)
        ? args.fileIds.map((x: unknown) => String(x)).filter(Boolean)
        : [];
      if (requestedIds.length) {
        const files = allFiles.filter((f) => requestedIds.includes(f.id));
        if (!files.length) {
          return JSON.stringify({ ok: false, error: "no encontré ese archivo en el producto; revisa los ids de multimedia del catálogo" });
        }
        for (const f of files.slice(0, 6)) {
          ctx.outbox.push({
            kind: "media",
            mediaUrl: f.url,
            mediaKind: mediaKindFor(f.type), // image|video|audio → media; pdf/other → document
            caption: f.description || undefined,
            fileName: f.originalName || undefined,
          });
        }
        return JSON.stringify({ ok: true, sent: Math.min(files.length, 6), nota: "Ya reenvié el/los archivo(s) pedido(s) al cliente. NO describas su contenido en tu texto final; cierra breve o deja el texto vacío." });
      }

      // Envío BULK por tipo (presentación inicial): con guard para no re-dumpear
      // todo en cada seguimiento. Para reenviar algo puntual, usa fileIds.
      const mediaSent = Array.isArray(ctx.state.mediaSentProductIds) ? ctx.state.mediaSentProductIds : [];
      if (mediaSent.includes(product.id)) {
        return JSON.stringify({ ok: true, alreadySent: true, nota: "Ya enviaste la multimedia de este producto. Si el cliente pide un archivo puntual o su consulta se relaciona con uno, reenvíalo con enviar_multimedia pasando su fileId en `fileIds`; si no, responde su consulta directamente sin reenviar todo." });
      }
      const wanted = String(args.kind ?? "all");
      const files = allFiles.filter((f) => {
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
          fileName: f.originalName || undefined,
        });
      }
      ctx.state.mediaSentProductIds = [...mediaSent, product.id];
      return JSON.stringify({ ok: true, sent: Math.min(files.length, 6), nota: "Ya envié los archivos (con su texto) al cliente. NO repitas ni describas su contenido en tu texto final; cierra breve o deja el texto vacío." });
    }

    case "agregar_carrito": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      const qty = Math.max(1, Number(args.quantity ?? 1));
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers
            .map((m: any) => ({ group: String(m?.group ?? ""), option: String(m?.option ?? "") }))
            .filter((m: { option: string }) => m.option)
        : undefined;
      const summary = await addToCart(ctx.companyId, ctx.customerId, product.id, qty, modifiers);
      ctx.state.selectedProductId = product.id;
      return JSON.stringify({
        ok: true,
        cart: summary.items.map((it) => ({
          name: it.name,
          qty: it.quantity,
          modifiers: it.modifiers.map((m) => m.option),
          lineTotal: (it.unitPrice * it.quantity).toFixed(2),
        })),
        total: summary.totalText,
      });
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
      return JSON.stringify({ ok: true, amount: amountText, sent: true, nota: "Ya envié el monto y los métodos de pago al cliente. NO los repitas en tu texto final; cierra breve o deja el texto vacío." });
    }

    case "validar_pago": {
      // Guard de secuencia: no se puede validar si nunca se enviaron los métodos de
      // pago al cliente (no tendría cómo pagar). Evita que el bot pida el nombre y
      // valide saltándose enviar_metodos_pago.
      if (!ctx.state.lastPaymentPromptAt) {
        return JSON.stringify({
          ok: false,
          error: "Aún no enviaste los métodos de pago al cliente. Usa primero enviar_metodos_pago; recién cuando el cliente diga que pagó, pídele el nombre del titular y valida.",
        });
      }
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
      const reasons: string[] = ((top as any)?.matchReasons ?? []) as string[];
      const nameMatched = reasons.includes("payer_name_exact") || reasons.includes("payer_name_similar");
      // El NOMBRE del titular es condición NECESARIA: el monto por sí solo no
      // aprueba (antes un nombre cualquiera pasaba si coincidía el importe).
      if (!top || !nameMatched) {
        ctx.state.status = "ESPERANDO_VALIDACION";
        return JSON.stringify({
          ok: false,
          approved: false,
          reason:
            "El nombre del titular no coincide con ningún comprobante recibido. NO apruebes el pago. Pide al cliente el nombre EXACTO que figura en su Yape/Plin (o que reenvíe la captura). Si insiste y no coincide, ofrece derivar a un asesor con derivar_humano.",
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
      // El recordatorio post-venta se programa automáticamente (plantilla configurada).
      return JSON.stringify({ ok: true, delivered });
    }

    case "registrar_pedido": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      if (product.productType !== "physical") {
        return JSON.stringify({ ok: false, error: "registrar_pedido es solo para productos físicos" });
      }
      const customerName = String(args.customerName ?? "").trim();
      const address = String(args.address ?? "").trim();
      if (!customerName || !address) {
        return JSON.stringify({ ok: false, error: "faltan nombre o dirección de entrega" });
      }
      const variant = String(args.variant ?? "").trim();
      const baseNotes = String(args.notes ?? "").trim();
      const notes = [variant ? `Variante: ${variant}` : "", baseNotes].filter(Boolean).join(" | ") || undefined;

      try {
        const order = await createAgentOrder({
          companyId: ctx.companyId,
          customerId: ctx.customerId,
          productId: product.id,
          quantity: Math.max(1, Number(args.quantity ?? 1)),
          customerName,
          address,
          reference: String(args.reference ?? "").trim(),
          notes,
        });
        ctx.state.status = "PEDIDO_REGISTRADO";
        ctx.state.selectedProductId = product.id;
        ctx.adminNotices.push(
          `🛒 Nuevo pedido ${order.orderCode}: ${order.quantity}x ${product.name} para ${customerName} (${ctx.customerPhone}). Dirección: ${address}.`,
        );
        return JSON.stringify({
          ok: true,
          orderCode: order.orderCode,
          note: "Pedido registrado. Confirma al cliente con el código y los próximos pasos de entrega.",
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo registrar el pedido" });
      }
    }

    case "registrar_pedido_carrito": {
      const cart = await summarizeCart(ctx.companyId, ctx.customerId);
      if (!cart.items.length) return JSON.stringify({ ok: false, error: "el carrito está vacío" });
      const customerName = String(args.customerName ?? "").trim();
      const address = String(args.address ?? "").trim();
      if (!customerName || !address) {
        return JSON.stringify({ ok: false, error: "faltan nombre o dirección/recojo" });
      }
      try {
        const order = await createOrderFromCart({
          companyId: ctx.companyId,
          customerId: ctx.customerId,
          cart,
          customerName,
          address,
          reference: String(args.reference ?? "").trim(),
          extraNotes: String(args.notes ?? "").trim(),
        });
        await checkoutCart(ctx.companyId, ctx.customerId, cart.totalText);
        ctx.state.status = "PEDIDO_REGISTRADO";
        const resumen = cart.items
          .map((it) => `${it.quantity}x ${it.name}${it.modifiers.length ? ` (${it.modifiers.map((m) => m.option).join(", ")})` : ""}`)
          .join(", ");
        ctx.adminNotices.push(
          `🍽️ Nuevo pedido ${order.orderCode} (${ctx.customerPhone}): ${resumen}. Total ${cart.totalText}. Entrega: ${address}.`,
        );
        return JSON.stringify({
          ok: true,
          orderCode: order.orderCode,
          total: cart.totalText,
          note: "Pedido registrado. Confirma al cliente con el código, el total y el tiempo estimado.",
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo registrar el pedido" });
      }
    }

    case "agendar_servicio": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "servicio no encontrado" });
      const requestedText = String(args.requestedText ?? "").trim();
      if (!requestedText) return JSON.stringify({ ok: false, error: "falta el horario solicitado" });
      try {
        const booking = await createBooking({
          companyId: ctx.companyId,
          customerId: ctx.customerId,
          productId: product.id,
          requestedText,
          modality: String(args.modality ?? "").trim() || null,
          notes: String(args.notes ?? "").trim() || null,
        });
        ctx.state.status = "RESERVA_SOLICITADA";
        ctx.state.selectedProductId = product.id;
        ctx.adminNotices.push(
          `📅 Nueva reserva (${ctx.customerPhone}): ${product.name} — "${requestedText}"${
            args.modality ? ` · ${args.modality}` : ""
          }.`,
        );
        return JSON.stringify({
          ok: true,
          bookingId: booking.id,
          note: "Reserva registrada como SOLICITADA. Confirma al cliente que un asesor coordinará el horario exacto.",
        });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo registrar la reserva" });
      }
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
