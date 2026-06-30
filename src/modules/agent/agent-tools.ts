/**
 * Herramientas (tool-calling) del agente. Cada una mapea a lógica/Prisma ya
 * existente; el modelo decide cuándo usarlas. Las que envían algo al cliente
 * (multimedia, métodos de pago, entrega) empujan mensajes al `outbox` que el
 * runtime vacía en orden por WhatsApp; el resto sólo devuelven datos al modelo.
 */

import { ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import type { ToolDefinition } from "../../lib/openai";
import type { getBotConfig } from "../bot/bot.service";
import type { ConversationState } from "./conversation.service";
import { setBotPaused } from "./conversation.service";
import { applyCrmAndTagActions } from "../crm/crm.service";
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
import { schedulePaymentRecheck, cancelPendingReminders } from "../scheduler/scheduler.service";
import { claimAvailableCredential, countAvailable, peekAvailableCredential } from "../streaming-inventory/streaming-inventory.service";
import { createSubscriptionForSale, type RenewalReminderConfig } from "../subscriptions/subscriptions.service";

/** Comparación laxa de nombres (acentos/orden) para detectar confusión de titular. */
function looseNameNorm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function sameHolder(input: string, holder: string): boolean {
  const a = looseNameNorm(input);
  const b = looseNameNorm(holder);
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = new Set(a.split(" ").filter((t) => t.length >= 3));
  const tb = new Set(b.split(" ").filter((t) => t.length >= 3));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common >= 2; // ≥2 nombres/apellidos en común = es nuestro titular
}

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
  /** Productos PRESENTADOS en ESTE turno (enviar_ficha). Evita que el modelo, en el
   *  mismo turno de la presentación, "complete" mandando los archivos on-demand
   *  (showInPresentation=false) vía enviar_multimedia. Transitorio por turno. */
  presentedThisTurn?: string[];
  /** modo simulación (Pruebas): los tools que escriben datos compartidos/reales
   * (validar_pago, registrar pedidos, reservas) se stubean para no afectar datos. */
  simulate?: boolean;
}

/**
 * Tras una entrega exitosa, agrega al cliente a la lista de atención humana
 * (AgentConfig.mutedNumbers) y pausa el bot. Dos caminos:
 *  - DEFAULT (heurística): solo si la empresa tiene UN producto en el catálogo del
 *    bot y no se ofreció enganche, y el flag `muteAfterSale` (default ON) no está OFF.
 *  - FORZADO (`opts.forced`): el producto vendido tiene `pauseHumanAfterSale=ON`, así
 *    que se mutea SIEMPRE, saltándose la heurística y el global muteAfterSale (override).
 * Best-effort: nunca rompe la entrega.
 */
/**
 * Núcleo del pase a atención humana: agrega el número del cliente a
 * AgentConfig.mutedNumbers y pausa el bot. Reutilizable por el agente (tras la
 * entrega) y por el worker de recheck (auto-entrega). Devuelve true si muteó.
 * Best-effort: nunca lanza.
 */
export async function muteCustomerToHuman(
  companyId: string,
  conversationId: string,
  customerPhone: string,
): Promise<boolean> {
  try {
    const digits = customerPhone.replace(/\D/g, "");
    if (!digits) return false;
    const cfg = await prisma.agentConfig.findUnique({
      where: { companyId },
      select: { mutedNumbers: true },
    });
    const list = Array.isArray(cfg?.mutedNumbers)
      ? (cfg!.mutedNumbers as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (!list.includes(digits)) {
      await prisma.agentConfig.update({
        where: { companyId },
        data: { mutedNumbers: [...list, digits] },
      });
    }
    await setBotPaused(companyId, conversationId, true);
    console.log(`[agent] muteCustomerToHuman: ${digits} agregado a atención humana (company=${companyId})`);
    return true;
  } catch (err) {
    console.warn("[agent] muteCustomerToHuman falló (se ignora):", err instanceof Error ? err.message : err);
    return false;
  }
}

async function maybeMuteAfterSale(ctx: TurnContext, opts: { forced?: boolean } = {}): Promise<void> {
  if (!opts.forced) {
    const agentCfg = (ctx.config as any).agent ?? {};
    if (agentCfg.muteAfterSale === false) return;
    const products = ctx.config.products ?? [];
    if (products.length !== 1) return;
  }
  const muted = await muteCustomerToHuman(ctx.companyId, ctx.conversationId, ctx.customerPhone);
  if (!muted) return;
  ctx.adminNotices.push(
    `✅ Venta entregada a ${ctx.customerPhone}. Pasé el chat a atención humana automáticamente ` +
      (opts.forced
        ? `(configurado en el producto).`
        : `(catálogo de 1 producto, sin producto de enganche).`) +
      ` Lo ves en Agente IA → Atención humana.`,
  );
}

const CLOSED_STATUSES = ["ENTREGADO", "PAGADO", "PEDIDO_REGISTRADO", "RESERVA_SOLICITADA"];

/**
 * Reabre el embudo (status → INTERESADO) si la conversación venía de una venta
 * CERRADA y el cliente se interesa en un producto que AÚN NO compró. Sin esto, el
 * status terminal (ENTREGADO/…) bloquearía los recordatorios de seguimiento del
 * nuevo producto. No reabre si el producto ya está comprado (no molestar con algo
 * que el cliente ya tiene).
 */
function reopenFunnelIfClosed(ctx: TurnContext, productId: string): void {
  const purchased = Array.isArray(ctx.state.purchasedProductIds) ? ctx.state.purchasedProductIds : [];
  if (CLOSED_STATUSES.includes(ctx.state.status ?? "") && !purchased.includes(productId)) {
    ctx.state.status = "INTERESADO";
  }
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

/**
 * Arma los mensajes de entrega digital (instrucciones + mensajes adicionales +
 * cross-sell) para los productos dados. Pura (no depende de TurnContext): la usa
 * `entregar_producto` (empuja a ctx.outbox) y `recheckPayment` (los envía por el
 * sender desde el worker). Devuelve el outbox, los nombres entregados y el id del
 * producto de cross-sell ofrecido (si hubo).
 */
// Empuja una lista de mensajes adicionales (texto y/o media) al outbox, en orden.
// Reutilizado por la entrega digital (followupMessages) y la presentación (presentationFollowups).
function pushFollowupList(
  outbox: OutboxMessage[],
  items: { message?: string; mediaUrl?: string; mediaType?: string }[] | undefined,
): void {
  for (const f of items ?? []) {
    const text = (f.message ?? "").trim();
    const media = (f.mediaUrl ?? "").trim();
    if (media) {
      outbox.push({ kind: "media", mediaUrl: media, mediaKind: mediaKindFor(f.mediaType || ""), caption: text || undefined });
    } else if (text) {
      outbox.push({ kind: "text", text });
    }
  }
}

// Empuja los mensajes adicionales (followups) de una entrega digital.
function pushFollowups(outbox: OutboxMessage[], dd: NonNullable<BotProduct["digitalDelivery"]>): void {
  pushFollowupList(outbox, dd.followupMessages);
}

// Ofrece el producto relacionado (cross-sell) tras una entrega. Devuelve el id ofrecido o null.
function pushCrossSell(
  outbox: OutboxMessage[],
  p: BotProduct,
  dd: NonNullable<BotProduct["digitalDelivery"]>,
  find: (id: string) => BotProduct | undefined,
  shouldPauseHuman: boolean,
): string | null {
  const crossId = shouldPauseHuman ? null : dd.crossSellProductId ?? null;
  if (!crossId) return null;
  const cross = find(crossId);
  if (!cross || cross.id === p.id) return null;
  const pitch = (dd.crossSellPitch ?? "").trim();
  const pitchMedia = (dd.crossSellPitchMediaUrl ?? "").trim();
  if (pitchMedia) {
    outbox.push({ kind: "media", mediaUrl: pitchMedia, mediaKind: mediaKindFor(dd.crossSellPitchMediaType || ""), caption: pitch || undefined });
  } else if (pitch) {
    outbox.push({ kind: "text", text: pitch });
  } else {
    const price = cross.priceText ?? cross.price;
    const desc = (cross.shortDescription ?? "").trim();
    outbox.push({
      kind: "text",
      text: `🎁 Además, podría interesarte *${cross.name}*` + (desc ? ` — ${desc}` : "") + (price ? ` (${price})` : "") + `. ¿Te cuento más?`,
    });
  }
  return cross.id;
}

// Sustituye variables de la plantilla de entrega con los datos de la credencial.
// Si la plantilla no tiene placeholders, anexa un bloque con los datos.
type CredentialLike = { email?: string | null; username?: string | null; password?: string | null; profileName?: string | null; pin?: string | null; extra?: string | null };
function renderCredentialDelivery(template: string, cred: CredentialLike): string {
  const map: Record<string, string> = {
    email: cred.email ?? "",
    correo: cred.email ?? "",
    usuario: cred.username ?? "",
    user: cred.username ?? "",
    username: cred.username ?? "",
    clave: cred.password ?? "",
    "contraseña": cred.password ?? "",
    contrasena: cred.password ?? "",
    password: cred.password ?? "",
    perfil: cred.profileName ?? "",
    profile: cred.profileName ?? "",
    pin: cred.pin ?? "",
    extra: cred.extra ?? "",
  };
  const base = (template ?? "").trim();
  if (/\{[^}]+\}/.test(base)) {
    return base.replace(/\{(\w+)\}/g, (_, k: string) => map[k.toLowerCase()] ?? "");
  }
  const lines: string[] = [];
  if (cred.email) lines.push(`Correo: ${cred.email}`);
  if (cred.username) lines.push(`Usuario: ${cred.username}`);
  if (cred.password) lines.push(`Contraseña: ${cred.password}`);
  if (cred.profileName) lines.push(`Perfil: ${cred.profileName}`);
  if (cred.pin) lines.push(`PIN: ${cred.pin}`);
  if (cred.extra) lines.push(cred.extra);
  const block = lines.join("\n");
  return base ? `${base}\n\n${block}` : block;
}

export interface AutoSaleInfo {
  name: string;
  plan: string | null;
  account: string | null; // identificador de la cuenta entregada (email/usuario)
  remaining: number; // stock disponible restante de ese plan
}

export interface AssignedDeliveryResult {
  outbox: OutboxMessage[];
  delivered: string[];        // entregados automáticamente (STATIC, o POOL_AUTO con stock)
  manualNeeded: string[];     // requieren entrega manual (MANUAL, o POOL_AUTO sin stock)
  outOfStock: string[];       // POOL_AUTO sin stock (subconjunto de manualNeeded; para aviso admin)
  autoSales: AutoSaleInfo[];  // ventas entregadas por inventario (POOL_AUTO real) → aviso al dueño
  offeredCrossSellId: string | null;
  offeredCatalog: boolean;
  shouldPauseHuman: boolean;
}

/**
 * Arma la entrega de los productos pagados según el modo por producto:
 *  - STATIC: mensaje fijo (instructions) + followups (comportamiento histórico).
 *  - POOL_AUTO: reclama una credencial del inventario (claim atómico) y entrega sus
 *    datos con la plantilla de instructions; si no hay stock → entrega manual.
 *  - MANUAL: no entrega; queda para que un asesor lo envíe.
 * Es async (toca la BD en POOL_AUTO). En `simulate` no consume stock real.
 */
export async function assignAndBuildDelivery(
  config: BotConfig,
  productIds: string[],
  opts: {
    companyId: string;
    customerId: string;
    conversationId?: string | null;
    planByProduct?: Record<string, string | undefined>;
    simulate?: boolean;
  },
): Promise<AssignedDeliveryResult> {
  const find = (id: string) => config.products.find((p) => p.id === id || p.slug === id);
  const outbox: OutboxMessage[] = [];
  const delivered: string[] = [];
  const manualNeeded: string[] = [];
  const outOfStock: string[] = [];
  const autoSales: AutoSaleInfo[] = [];
  let offeredCrossSellId: string | null = null;
  let offeredCatalog = false;
  const shouldPauseHuman = productIds.some((id) => (find(id) as { pauseHumanAfterSale?: boolean } | undefined)?.pauseHumanAfterSale === true);

  for (const id of productIds) {
    const p = find(id);
    const dd = p?.digitalDelivery;
    if (!p || p.productType !== "digital" || !dd) continue;
    const mode = (dd as { assignmentMode?: string }).assignmentMode ?? "STATIC";

    if (mode === "MANUAL") {
      manualNeeded.push(p.name);
      continue;
    }

    if (mode === "POOL_AUTO") {
      const days = Number((p.verticalData as Record<string, unknown> | null)?.durationDays);
      const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400000) : null;
      const optionLabel = opts.planByProduct?.[p.id] ?? opts.planByProduct?.[p.slug] ?? null;
      let cred: CredentialLike | null = null;
      if (opts.simulate) {
        // Simulador: muestra una credencial REAL del inventario como vista previa,
        // SIN consumir stock (read-only). Si no hay, cred=null → flujo "sin stock".
        cred = await peekAvailableCredential(opts.companyId, p.id, optionLabel);
      } else {
        cred = await claimAvailableCredential(opts.companyId, p.id, optionLabel, {
          customerId: opts.customerId,
          conversationId: opts.conversationId,
          expiresAt,
        });
      }
      if (!cred) {
        manualNeeded.push(p.name);
        outOfStock.push(p.name);
        continue;
      }
      outbox.push({ kind: "text", text: renderCredentialDelivery(dd.instructions ?? "", cred) });
      pushFollowups(outbox, dd);
      const crossId = pushCrossSell(outbox, p, dd, find, shouldPauseHuman);
      if (crossId) offeredCrossSellId = crossId;
      delivered.push(p.name);
      // Aviso al dueño (solo venta real por inventario): cuenta entregada + stock restante.
      if (!opts.simulate) {
        const remaining = await countAvailable(opts.companyId, p.id, optionLabel);
        autoSales.push({
          name: p.name,
          plan: optionLabel ?? null,
          account: cred.email || cred.username || cred.profileName || null,
          remaining,
        });
      }
      continue;
    }

    // STATIC (default) — comportamiento histórico (infoproducto).
    if (!dd.instructions?.trim()) continue;
    outbox.push({ kind: "text", text: dd.instructions.trim() });
    pushFollowups(outbox, dd);
    const crossId = pushCrossSell(outbox, p, dd, find, shouldPauseHuman);
    if (crossId) offeredCrossSellId = crossId;
    delivered.push(p.name);
  }

  // Invitación al resto del catálogo (solo si hubo entrega automática, sin cross-sell,
  // sin handoff pendiente y sin pasar a humano).
  if (delivered.length && !offeredCrossSellId && !shouldPauseHuman && !manualNeeded.length) {
    const deliveredIds = new Set(productIds);
    const remaining = catalogProducts(config.products).filter(
      (p) => !deliveredIds.has(p.id) && !deliveredIds.has(p.slug),
    );
    if (remaining.length) {
      outbox.push({
        kind: "text",
        text: "😊 Por cierto, tenemos más en el catálogo. ¿Quieres que te muestre las demás opciones? 👀",
      });
      offeredCatalog = true;
    }
  }

  // Productos con entrega manual / sin stock: avisar al cliente que un asesor envía el acceso.
  if (manualNeeded.length) {
    let manualText: string;
    if (delivered.length === 0) {
      // Todo el pedido es manual: mensaje genérico (no listamos producto por producto).
      manualText =
        manualNeeded.length > 1
          ? "¡Listo! ✅ Un asesor te enviará tus accesos en breve 🙏"
          : `¡Listo! ✅ Un asesor te enviará tu acceso de *${manualNeeded[0]}* en breve 🙏`;
    } else {
      // Mixto: ya entregamos lo automático; avisamos solo de lo que falta (manual/sin stock).
      manualText = `Y para *${manualNeeded.join(", ")}* un asesor te enviará el acceso en breve 🙏`;
    }
    outbox.push({ kind: "text", text: manualText });
  }

  return { outbox, delivered, manualNeeded, outOfStock, autoSales, offeredCrossSellId, offeredCatalog, shouldPauseHuman };
}

/** Formatea el aviso al dueño de una venta automática (entrega por inventario). */
export function autoSaleNotice(s: AutoSaleInfo, customerPhone: string): string {
  return (
    `💰 Venta automática: *${s.name}*${s.plan ? ` (${s.plan})` : ""} a ${customerPhone}.` +
    (s.account ? ` Cuenta entregada: ${s.account}.` : "") +
    ` Stock restante: ${s.remaining}.`
  );
}

// --------------------------------------------------------------------------
// Núcleo de validación de pago (compartido por validar_pago, la auto-validación
// al llegar la imagen, y el reintento del worker). El N° de operación / código
// del comprobante es la llave; el nombre solo se usa si no hay imagen.
// --------------------------------------------------------------------------
export interface ApprovePaymentResult {
  approved: boolean;
  /** 'already' ya pagado; resto = motivo del no-aprobado para el mensaje. */
  kind?: "already" | "confusion" | "needs_info" | "amount_mismatch" | "timing";
  /** Mensaje listo para el cliente (no-aprobado, o confirmación). */
  customerMessage?: string;
  /** Mensajes de entrega (solo cuando deliver=true y se aprobó un digital). */
  deliveryOutbox?: OutboxMessage[];
  delivered?: string[];
  offeredCrossSellId?: string | null;
  /** El producto entregado tiene pauseHumanAfterSale=ON → el caller debe pasar a humano. */
  shouldPauseHuman?: boolean;
  /** Productos que requieren entrega manual (modo MANUAL o POOL_AUTO sin stock). */
  manualNeeded?: string[];
  /** Productos POOL_AUTO sin stock (subconjunto de manualNeeded; para aviso al admin). */
  outOfStock?: string[];
  /** Ventas entregadas por inventario (POOL_AUTO) → aviso al dueño con cuenta + stock. */
  autoSales?: AutoSaleInfo[];
  /** Si quedó pendiente por timing (el caller decide si agenda el recheck). */
  shouldRecheck?: boolean;
}

function parseAmountNumber(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const n = Number(String(text).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Mapa productId -> plan elegido (opción del grupo "Plan") leído del carrito. */
function planByProductFromCart(cart: Awaited<ReturnType<typeof summarizeCart>>): Record<string, string | undefined> {
  const m: Record<string, string | undefined> = {};
  for (const it of cart.items) {
    const plan = it.modifiers?.find((x) => (x.group ?? "").toLowerCase().trim() === "plan")?.option;
    if (plan) m[it.productId] = plan;
  }
  return m;
}

/**
 * Registra suscripciones (vencimiento) para los productos STREAMER con `durationDays`
 * recién vendidos. Best-effort y con dedupe (no duplica si ya hay una vigente). Solo
 * aplica a productos con duración → no afecta INFOPRODUCT (no tiene durationDays).
 */
async function registerStreamingSubscriptions(opts: {
  config: BotConfig;
  companyId: string;
  customerId: string;
  conversationId?: string | null;
  productIds: string[];
  planByProduct: Record<string, string | undefined>;
}): Promise<void> {
  for (const pid of opts.productIds) {
    const p = opts.config.products.find((x) => x.id === pid || x.slug === pid);
    if (!p) continue;
    const dur = Number((p.verticalData as Record<string, unknown> | null)?.durationDays);
    if (!Number.isFinite(dur) || dur <= 0) continue;
    const renewal = (p.reminderConfig as { renewal?: RenewalReminderConfig } | null)?.renewal;
    await createSubscriptionForSale({
      companyId: opts.companyId,
      customerId: opts.customerId,
      conversationId: opts.conversationId ?? null,
      productId: p.id,
      productName: p.name,
      planLabel: opts.planByProduct[p.id] ?? opts.planByProduct[p.slug] ?? null,
      durationDays: dur,
      amount: p.priceText ?? p.price ?? null,
      reminder: renewal,
    });
  }
}

/**
 * Intenta aprobar el pago con las señales disponibles. Si matchea (código u
 * nombre), reclama y aprueba el comprobante; con `deliver=true` arma además la
 * entrega del producto digital. Devuelve el resultado para que cada caller emita
 * los mensajes (a outbox o por el sender). No agenda el recheck (lo decide el
 * caller). No lanza.
 */
export async function tryApprovePayment(opts: {
  companyId: string;
  customerId: string;
  conversationId: string;
  customerPhone: string;
  config: BotConfig;
  state: ConversationState;
  payerName?: string;
  codes: string[];
  expected?: number;
  deliver: boolean;
}): Promise<ApprovePaymentResult> {
  const { companyId, customerId, config, state } = opts;
  const payerName = (opts.payerName ?? "").trim();
  const codes = (opts.codes ?? []).map((c) => String(c).replace(/\D/g, "")).filter((c) => c.length >= 3);

  // Idempotencia: ya pagado/entregado → no re-aprobar ni re-entregar.
  const status = state.status ?? "";
  if (status === "PAGADO" || status === "ENTREGADO") {
    return {
      approved: true,
      kind: "already",
      customerMessage: "Tu pago ya está confirmado ✅. ¿Te ayudo con algo más?",
    };
  }

  const cart = await summarizeCart(companyId, customerId);
  const expected =
    opts.expected ??
    (cart.total > 0 ? cart.total : parseAmountNumber(findProductPrice(config, state.selectedProductId)));

  const candidates = await matchPayments(companyId, {
    payerName: payerName || undefined,
    amountPaid: expected,
    operationCodes: codes,
    limit: 5,
  } as any);
  const top = candidates[0] as any;
  const reasons: string[] = (top?.matchReasons ?? []) as string[];
  const codeMatched = reasons.includes("operation_code_exact");
  const nameMatched = reasons.includes("payer_name_exact") || reasons.includes("payer_name_similar");

  if (top && (codeMatched || nameMatched)) {
    const productIds = cart.productIds.length
      ? cart.productIds
      : state.selectedProductId
      ? [state.selectedProductId]
      : [];
    try {
      await claimPayment(companyId, top.id, { claimedBy: "agent", claimTtlSeconds: 120 } as any);
      await updatePaymentStatus(companyId, top.id, {
        status: "APROBADO",
        validationMode: "AUTO",
        matchScore: top.matchScore,
        matchStrategy: reasons.join("+") || "agent_auto",
        matchedPayerNameInput: payerName || (codes[0] ?? ""),
        customerPhone: opts.customerPhone,
        productIds,
      } as any);
    } catch {
      return {
        approved: false,
        kind: "timing",
        customerMessage:
          "Estoy validando tu pago automáticamente 🙏 dame un momentito y te confirmo.",
        shouldRecheck: true,
      };
    }
    if (cart.items.length) await checkoutCart(companyId, customerId, cart.totalText);
    state.pendingRecheckAt = null;
    state.paymentAttempts = 0;

    // Pagó: cancelar los follow-ups de abandono/silencio pendientes (ya no aplican).
    try {
      await cancelPendingReminders(companyId, customerId, [
        ScheduledMessageType.ABANDONED_CART,
        ScheduledMessageType.LEFT_ON_READ,
        ScheduledMessageType.OFFER_COUNTDOWN,
        ScheduledMessageType.POST_SALE,
      ]);
    } catch {
      /* best-effort */
    }

    if (opts.deliver) {
      const del = await assignAndBuildDelivery(config, productIds, {
        companyId,
        customerId,
        conversationId: opts.conversationId,
        planByProduct: planByProductFromCart(cart),
      });
      if (del.delivered.length || del.manualNeeded.length) {
        const needsHandoff = del.manualNeeded.length > 0;
        state.status = del.delivered.length ? "ENTREGADO" : "PAGADO";
        if (del.offeredCrossSellId) state.offeredCrossSellProductId = del.offeredCrossSellId;
        // Suscripciones de vencimiento (solo productos STREAMER con duración).
        await registerStreamingSubscriptions({
          config,
          companyId,
          customerId,
          conversationId: opts.conversationId,
          productIds,
          planByProduct: planByProductFromCart(cart),
        });
        return {
          approved: true,
          deliveryOutbox: del.outbox,
          delivered: del.delivered,
          offeredCrossSellId: del.offeredCrossSellId,
          shouldPauseHuman: del.shouldPauseHuman || needsHandoff,
          manualNeeded: del.manualNeeded,
          outOfStock: del.outOfStock,
          autoSales: del.autoSales,
          customerMessage: del.delivered.length
            ? "¡Pago confirmado! ✅ Te entrego tu acceso ahora mismo 👇"
            : "¡Pago confirmado! ✅",
        };
      }
    }
    // Aprobado sin entrega automática (no digital o deliver=false): el flujo del
    // modelo continúa con entregar_producto/registrar_pedido.
    state.status = "PAGADO";
    return { approved: true };
  }

  // No aprobado: decidir el motivo y el mensaje al cliente.
  state.status = "ESPERANDO_VALIDACION";

  // (a) Confusión de titular: mandó NUESTRO nombre y no hay código.
  const holders = ((config.payment?.methods ?? []) as Array<{ holder?: string }>)
    .map((m) => m.holder ?? "")
    .filter(Boolean);
  if (payerName && !codes.length && holders.some((h) => sameHolder(payerName, h))) {
    return {
      approved: false,
      kind: "confusion",
      customerMessage:
        "Ese es el titular de NUESTRA cuenta 🙂 (a quién le pagaste), no el tuyo. Para validar tu pago necesito el nombre del titular de TU Yape/Plin (desde donde pagaste) o que me reenvíes la captura del comprobante.",
    };
  }

  // (b) Sin ninguna señal útil: pedir el nombre del titular de SU Yape/Plin.
  if (!payerName && !codes.length) {
    return {
      approved: false,
      kind: "needs_info",
      customerMessage:
        "¡Gracias! Para validar tu pago, dime por favor el *nombre del titular* de tu Yape o Plin (la cuenta DESDE donde hiciste el pago) 🙏",
    };
  }

  // (c) Monto distinto al esperado (lo leído no cuadra): avisar.
  const readAmount = parseAmountNumber(state.lastReceipt?.amountText);
  if (expected && readAmount && Math.abs(readAmount - expected) >= 0.5) {
    return {
      approved: false,
      kind: "amount_mismatch",
      customerMessage: `Veo un comprobante por S/ ${readAmount}, pero el monto a pagar es S/ ${expected}. ¿Me reenvías el comprobante correcto? 🙏`,
    };
  }

  // (d) Timing: el comprobante puede no haber entrado aún → reintento en 2º plano.
  return {
    approved: false,
    kind: "timing",
    customerMessage: "Estoy validando tu pago automáticamente 🙏 dame un momentito y te confirmo.",
    shouldRecheck: true,
  };
}

function findProductPrice(config: BotConfig, productId: string | null | undefined): string | undefined {
  if (!productId) return undefined;
  const p = config.products.find((x) => x.id === productId || x.slug === productId);
  return (p?.priceText ?? p?.price) || undefined;
}

/**
 * Empuja al outbox la multimedia de PRESENTACIÓN del producto (archivos marcados
 * `showInPresentation`), respetando el guard `mediaSentProductIds` para no
 * re-dumpearla en seguimientos. Devuelve cuántos archivos encoló. Se usa tanto
 * desde `enviar_ficha` (acople determinista ficha+media) como desde el envío BULK
 * de `enviar_multimedia`, para que el modelo no pueda "olvidar" mandar la media.
 */
function pushPresentationMedia(ctx: TurnContext, product: BotProduct, kind: string = "all"): number {
  const mediaSent = Array.isArray(ctx.state.mediaSentProductIds) ? ctx.state.mediaSentProductIds : [];
  if (mediaSent.includes(product.id)) return 0;
  const files = (product.files ?? []).filter((f) => {
    if (!f.showInPresentation) return false; // fuera de la presentación: solo on-demand vía fileIds
    if (kind === "all") return true;
    if (kind === "pdf") return f.type === "pdf";
    return f.type === kind;
  });
  if (!files.length) return 0;
  for (const f of files.slice(0, 6)) {
    ctx.outbox.push({
      kind: "media",
      mediaUrl: f.url,
      mediaKind: mediaKindFor(f.type), // image|video|audio → media; pdf/other → document
      caption: f.description || undefined,
      fileName: f.originalName || undefined,
    });
  }
  ctx.state.mediaSentProductIds = [...mediaSent, product.id];
  return Math.min(files.length, 6);
}

/** Ficha customer-facing de un producto con los campos configurados (paso 3). */
function parseFichaPrice(value: unknown): number {
  if (value == null) return 0;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Planes/modalidades (verticalData.modifierGroups) con precio ABSOLUTO = base + delta. Solo STREAMER. */
function streamerPlanLines(p: BotProduct): string[] {
  const v = (p.verticalData ?? null) as Record<string, unknown> | null;
  const groups = v && Array.isArray(v.modifierGroups) ? (v.modifierGroups as any[]) : [];
  if (!groups.length) return [];
  const base = parseFichaPrice(p.priceText ?? p.price);
  const lines: string[] = [];
  for (const grp of groups) {
    for (const o of grp.options ?? []) {
      if (!o?.label) continue;
      lines.push(`• ${o.label} — S/ ${(base + (Number(o.priceDelta) || 0)).toFixed(2)}`);
    }
  }
  return lines;
}

function renderProductFicha(p: BotProduct, vertical?: string): string {
  const parts: string[] = [`*${p.name}*`];
  const desc = (p.fullDescription || p.shortDescription || "").trim();
  if (desc) parts.push(desc);
  if (p.benefits?.length) parts.push(`*Lo que logras:*\n${p.benefits.join("\n")}`);
  if (p.includes?.length) parts.push(`*Incluye:*\n${p.includes.join("\n")}`);
  if (p.bonuses?.length) parts.push(`*Bonos:*\n${p.bonuses.join("\n")}`);
  // STREAMER con varios planes: listar cada plan con su precio (en vez de un precio fijo).
  const planLines = vertical === "STREAMER" ? streamerPlanLines(p) : [];
  if (planLines.length) {
    parts.push(`📋 *Planes y precios:*\n${planLines.join("\n")}`);
  } else {
    const price = p.priceText ?? p.price;
    parts.push(
      p.regularPriceText ? `💰 *${price}*  ~antes ${p.regularPriceText}~` : `💰 *${price}*`,
    );
  }
  return parts.join("\n\n");
}

/** Productos visibles en el catálogo (excluye los marcados como secundarios). */
function catalogProducts(products: BotProduct[]): BotProduct[] {
  return products.filter((p) => (p as { showInCatalog?: boolean }).showInCatalog !== false);
}

/** Catálogo customer-facing (sin ids/alias), agrupado por categoría si existe. */
function renderCustomerCatalog(products: BotProduct[], vertical?: string): string {
  const line = (p: BotProduct) => {
    let price = p.priceText ?? p.price;
    // STREAMER con varios planes: mostrar "desde S/{mínimo}" en vez de un precio fijo.
    if (vertical === "STREAMER") {
      const lines = streamerPlanLines(p);
      if (lines.length) {
        const base = parseFichaPrice(p.priceText ?? p.price);
        const v = (p.verticalData ?? null) as Record<string, unknown> | null;
        const groups = v && Array.isArray(v.modifierGroups) ? (v.modifierGroups as any[]) : [];
        const prices = groups.flatMap((g) =>
          (g.options ?? []).map((o: any) => base + (Number(o.priceDelta) || 0)),
        );
        if (prices.length) price = `desde S/ ${Math.min(...prices).toFixed(2)}`;
      }
    }
    // Trim del nombre: los espacios dentro de *...* rompen el negrita de WhatsApp
    // y se ven feos ("* *"). La descripción va en una línea aparte para que respire.
    const name = (p.name ?? "").trim();
    const desc = p.shortDescription?.trim() ? `\n${p.shortDescription.trim()}` : "";
    return `• *${name}* — ${price}${desc}`;
  };
  // Línea en blanco entre productos: se ve más limpio.
  const hasCat = products.some((p) => p.category && p.category.trim());
  if (!hasCat) return products.map(line).join("\n\n");
  const groups = new Map<string, BotProduct[]>();
  for (const p of products) {
    const c = p.category?.trim() || "Otros";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(p);
  }
  const sections: string[] = [];
  for (const [cat, items] of groups) sections.push(`*${cat}*\n\n${items.map(line).join("\n\n")}`);
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
        "Valida automáticamente el pago del cliente buscando un comprobante recibido que coincida por el N° de operación / código del comprobante o por el nombre del titular y el monto. Devuelve si quedó APROBADO. Úsalo cuando el cliente diga que pagó o mande su comprobante. Si el cliente mandó la captura (ya se leyó el N° de operación), NO necesitas el nombre: llama sin payerName. El nombre solo hace falta si el cliente NO mandó imagen.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          payerName: {
            type: "string",
            description: "Opcional. Nombre del titular del Yape/Plin de DONDE pagó el cliente (no el nuestro). Omítelo si el cliente mandó la captura del comprobante.",
          },
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
      // Re-enganche tras una venta cerrada: presentar un producto nuevo reabre el embudo.
      reopenFunnelIfClosed(ctx, product.id);
      const presented = Array.isArray(ctx.state.presentedProductIds) ? ctx.state.presentedProductIds : [];
      if (presented.includes(product.id)) {
        return JSON.stringify({ ok: true, alreadySent: true, nota: "Ya enviaste la ficha de este producto en esta conversación. NO la reenvíes; responde la consulta del cliente directamente con la base de conocimiento (faq, objeciones, descripción)." });
      }
      ctx.state.presentedProductIds = [...presented, product.id];
      // Marca que se presentó en ESTE turno: enviar_multimedia no debe "completar"
      // con los archivos on-demand junto a la presentación (solo si el cliente los pide después).
      ctx.presentedThisTurn = [...(ctx.presentedThisTurn ?? []), product.id];

      // Acciones al ENVIAR la info completa: mover al cliente a una pestaña del CRM
      // y/o etiquetarlo (best-effort, no rompe la presentación). Corre una sola vez
      // por producto presentado (la guarda `presented.includes` arriba ya hizo return).
      if (!ctx.simulate) {
        const ddPres = product.digitalDelivery;
        if (ddPres && (ddPres.onPresentationCrmId || (ddPres.onPresentationTagIds?.length ?? 0) > 0)) {
          try {
            await applyCrmAndTagActions(ctx.companyId, ctx.customerId, {
              tagIds: ddPres.onPresentationTagIds,
              crmId: ddPres.onPresentationCrmId,
              crmColumnId: ddPres.onPresentationCrmColumnId,
            });
          } catch (err) {
            console.error("[agent] acciones CRM al presentar fallaron:", err instanceof Error ? err.message : err);
          }
        }
      }

      const fichaVertical = (ctx.config.business as { vertical?: string }).vertical;
      const presentationMessage = (product as { presentationMessage?: string | null }).presentationMessage?.trim();
      const presentationFollowups = (product as { presentationFollowups?: { message?: string; mediaUrl?: string; mediaType?: string }[] }).presentationFollowups ?? [];

      // STREAMER (sin mensaje de presentación fijo): el AGENTE redacta la presentación
      // (más natural, con emojis y espaciada). Solo adjuntamos la multimedia y le pasamos
      // los planes con precios EXACTOS para que no invente. Otros rubros: ficha determinista.
      if (fichaVertical === "STREAMER" && !presentationMessage) {
        const mediaSent = pushPresentationMedia(ctx, product);
        pushFollowupList(ctx.outbox, presentationFollowups);
        const planes = streamerPlanLines(product); // ["Mensual por perfil — S/ 16.00", ...] o []
        return JSON.stringify({
          ok: true,
          present: true,
          mediaSent,
          producto: { nombre: product.name, descripcion: product.shortDescription ?? "", planes },
          nota:
            "PRESENTA TÚ este producto al cliente, con tus palabras: claro y atractivo, con algún emoji y líneas separadas (NO lo pongas todo pegado). " +
            (planes.length ? "Incluye los planes con sus precios EXACTOS de 'planes' (no inventes ni cambies precios; no digas que es 'fijo'). " : "") +
            "Cierra con una pregunta para que elija." +
            (mediaSent ? " (Ya adjunté la multimedia; no la describas.)" : ""),
        });
      }

      // Si el dueño configuró un mensaje de presentación, se envía TAL CUAL (respeta
      // saltos de línea); si no, el bot arma la ficha con los campos estructurados.
      const fichaText = presentationMessage || renderProductFicha(product, fichaVertical);
      // Si la info completa tiene multimedia adjunta, se envía como UN solo mensaje
      // (media con el texto como caption); si no, como texto plano (como antes).
      const presMediaUrl = (product as { presentationMessageMediaUrl?: string | null }).presentationMessageMediaUrl?.trim();
      const presMediaType = (product as { presentationMessageMediaType?: string | null }).presentationMessageMediaType?.trim();
      if (presMediaUrl) {
        ctx.outbox.push({ kind: "media", mediaUrl: presMediaUrl, mediaKind: mediaKindFor(presMediaType || ""), caption: fichaText || undefined });
      } else {
        ctx.outbox.push({ kind: "text", text: fichaText });
      }
      // Acople determinista: adjuntamos AQUÍ mismo la multimedia de presentación
      // (showInPresentation) en lugar de depender de que el modelo encadene
      // enviar_multimedia después (a veces lo omitía → la ficha llegaba sin media).
      const fichaMedia = pushPresentationMedia(ctx, product);
      // Mensajes adicionales de la info completa (texto/media), tras el principal y la media.
      pushFollowupList(ctx.outbox, presentationFollowups);
      return JSON.stringify({
        ok: true,
        sent: true,
        mediaSent: fichaMedia,
        nota: fichaMedia
          ? "Ya envié la ficha (descripción, beneficios, incluye, bonos, precio) Y la multimedia de presentación al cliente. NO los repitas ni describas su contenido en tu texto final; cierra con UNA frase breve preguntando si lo quiere."
          : "Ya envié la ficha (descripción, beneficios, incluye, bonos, precio) al cliente. NO la repitas en tu texto final.",
      });
    }

    case "enviar_catalogo": {
      // Solo productos visibles en catálogo (excluye los secundarios/oculto).
      const products = catalogProducts(ctx.config.products);
      if (!products.length) return JSON.stringify({ ok: false, error: "no hay productos en el catálogo" });
      const body = renderCustomerCatalog(products, (ctx.config.business as { vertical?: string }).vertical);
      ctx.outbox.push({
        kind: "text",
        text: `¡Hola! 👋 Gracias por escribirnos a *${ctx.config.business.name}* ✨ Esto es lo que tenemos para ti:\n\n${body}\n\n¿Cuál te llama la atención? Con gusto te cuento más 😊`,
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
        let files = allFiles.filter((f) => requestedIds.includes(f.id));
        if (!files.length) {
          return JSON.stringify({ ok: false, error: "no encontré ese archivo en el producto; revisa los ids de multimedia del catálogo" });
        }
        // GUARDA: si el producto se acaba de PRESENTAR en este mismo turno, NO "completar"
        // mandando los archivos on-demand (showInPresentation=false). La presentación ya envió
        // los marcados; los on-demand solo salen si el cliente los pide explícitamente en un
        // mensaje aparte (en ese turno ctx.presentedThisTurn ya no incluye el producto).
        if ((ctx.presentedThisTurn ?? []).includes(product.id)) {
          const filtered = files.filter((f) => f.showInPresentation !== false);
          if (filtered.length !== files.length) {
            files = filtered;
            if (!files.length) {
              return JSON.stringify({ ok: true, sent: 0, nota: "Esos archivos NO están marcados para la presentación inicial (son on-demand). Acabas de presentar el producto, así que NO los envíes ahora: solo mándalos si el cliente pide ESE archivo o contenido en concreto en un mensaje posterior. Cierra preguntando si quiere comprarlo o si tiene alguna duda." });
            }
          }
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

      // Envío BULK (presentación/info inicial): solo los archivos marcados para la
      // presentación (showInPresentation). Con guard para no re-dumpear todo en
      // cada seguimiento. Para enviar algo puntual (marcado o no), usa fileIds.
      const mediaSent = Array.isArray(ctx.state.mediaSentProductIds) ? ctx.state.mediaSentProductIds : [];
      if (mediaSent.includes(product.id)) {
        return JSON.stringify({ ok: true, alreadySent: true, nota: "Ya enviaste la multimedia de presentación de este producto. Si el cliente pide un archivo puntual o su consulta se relaciona con uno, reenvíalo con enviar_multimedia pasando su fileId en `fileIds`; si no, responde su consulta directamente sin reenviar todo." });
      }
      const sentCount = pushPresentationMedia(ctx, product, String(args.kind ?? "all"));
      if (!sentCount) return JSON.stringify({ ok: true, sent: 0, nota: "Este producto no tiene archivos marcados para la presentación inicial. No envíes multimedia ahora; si el cliente pide un archivo específico, búscalo en la lista del catálogo y mándalo con fileIds." });
      return JSON.stringify({ ok: true, sent: sentCount, nota: "Ya envié los archivos (con su texto) al cliente. NO repitas ni describas su contenido en tu texto final; cierra breve o deja el texto vacío." });
    }

    case "agregar_carrito": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      // Guard anti-reventa: no agregar al carrito un producto DIGITAL ya comprado.
      const purchasedCart = Array.isArray(ctx.state.purchasedProductIds) ? ctx.state.purchasedProductIds : [];
      if (purchasedCart.includes(product.id) && product.productType !== "physical") {
        return JSON.stringify({ ok: false, error: "El cliente YA compró este producto digital; no lo agregues al carrito ni lo cobres de nuevo. Es soporte post-venta; si hay un problema con su compra usa derivar_humano." });
      }
      const qty = Math.max(1, Number(args.quantity ?? 1));
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers
            .map((m: any) => ({ group: String(m?.group ?? ""), option: String(m?.option ?? "") }))
            .filter((m: { option: string }) => m.option)
        : undefined;
      // Stock real solo para entrega por inventario (POOL_AUTO): no agregar lo que no
      // podremos entregar. Para STATIC/MANUAL y otros rubros no aplica.
      if (!ctx.simulate && (product.digitalDelivery as { assignmentMode?: string } | null)?.assignmentMode === "POOL_AUTO") {
        const plan = modifiers?.find((m) => m.group.toLowerCase().trim() === "plan")?.option ?? null;
        const available = await countAvailable(ctx.companyId, product.id, plan);
        if (available < qty) {
          return JSON.stringify({
            ok: false,
            outOfStock: true,
            available,
            error: available === 0
              ? `Sin stock de "${product.name}"${plan ? ` (${plan})` : ""} por ahora. Ofrece otra modalidad/plataforma disponible o avisa que un asesor lo consigue; NO lo agregues al carrito.`
              : `Solo quedan ${available} de "${product.name}"${plan ? ` (${plan})` : ""}. Ajusta la cantidad u ofrece otra opción.`,
          });
        }
      }
      const summary = await addToCart(ctx.companyId, ctx.customerId, product.id, qty, modifiers);
      ctx.state.selectedProductId = product.id;
      // Re-enganche tras una venta cerrada: agregar un producto nuevo reabre el embudo.
      reopenFunnelIfClosed(ctx, product.id);
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
      // Guard anti-reventa: no re-cobrar un producto DIGITAL que el cliente YA compró.
      // (Un físico sí podría re-pedirse; un infoproducto ya entregado no.)
      const purchased = Array.isArray(ctx.state.purchasedProductIds) ? ctx.state.purchasedProductIds : [];
      const chargeIds = cart.productIds.length
        ? cart.productIds
        : ctx.state.selectedProductId
        ? [ctx.state.selectedProductId]
        : [];
      const newIds = chargeIds.filter((id) => !purchased.includes(id));
      if (chargeIds.length && newIds.length === 0) {
        const allDigital = chargeIds.every((id) => findProductById(ctx, id)?.productType !== "physical");
        if (allDigital) {
          return JSON.stringify({ ok: false, error: "El cliente YA compró este producto (es suyo); NO le cobres de nuevo ni le ofrezcas 'activarlo/comprarlo'. Es SOPORTE post-venta: responde su duda. Si dice que no le llegó el acceso o hay un problema con su compra, usa derivar_humano." });
        }
      }
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
        `Cuando pagues, mándame la *captura del comprobante* o el *nombre del titular* de tu Yape/Plin (la cuenta DESDE donde pagaste) y validamos tu pago al instante ✅`;
      ctx.outbox.push({ kind: "text", text });
      ctx.state.status = "ESPERANDO_PAGO";
      ctx.state.lastPaymentPromptAt = new Date().toISOString();
      return JSON.stringify({ ok: true, amount: amountText, sent: true, nota: "Ya envié el monto y los métodos de pago al cliente. NO los repitas en tu texto final; cierra breve o deja el texto vacío." });
    }

    case "validar_pago": {
      // Guard de secuencia: no se puede validar si nunca se enviaron los métodos de
      // pago al cliente (no tendría cómo pagar).
      if (!ctx.state.lastPaymentPromptAt) {
        return JSON.stringify({
          ok: false,
          error: "Aún no enviaste los métodos de pago al cliente. Usa primero enviar_metodos_pago; recién cuando el cliente diga que pagó, valida con el N° de operación del comprobante o el nombre del titular.",
        });
      }

      // SIMULACIÓN: no tocar PaymentReceipt reales; aprobar de frente.
      if (ctx.simulate) {
        const cartSim = await summarizeCart(ctx.companyId, ctx.customerId);
        // Capturar el combo ANTES de cerrar el carrito: entregar_producto (sim) lee de aquí
        // (si no, summarizeCart devolvería vacío y se perdería todo menos el último producto).
        ctx.state.pendingDeliveryProductIds = cartSim.productIds.length
          ? cartSim.productIds
          : ctx.state.selectedProductId
          ? [ctx.state.selectedProductId]
          : [];
        if (cartSim.items.length) await checkoutCart(ctx.companyId, ctx.customerId, cartSim.totalText);
        ctx.state.status = "PAGADO";
        return JSON.stringify({ ok: true, approved: true, note: "(simulación) Pago aprobado. Ahora entrega el producto con entregar_producto." });
      }

      // La llave es el CÓDIGO DE SEGURIDAD (solo Yape→Yape); ValidPay lo manda como
      // "Nombre (cód: xxx)". En otros casos no hay código → se valida por nombre.
      const codes = [ctx.state.lastReceipt?.securityCode]
        .map((c) => (c ?? "").trim())
        .filter(Boolean) as string[];
      // Si la captura trae código, validamos SOLO por el código e IGNORAMOS el texto
      // que el cliente haya mandado (ej. "Mio personal"): ese texto no es un nombre de
      // titular útil y solo ensucia las ramas de confusión/intentos. Sin código (Plin)
      // sí usamos el nombre que el cliente dé.
      const payerName = codes.length ? "" : String(args.payerName ?? "").trim();

      // GUARDA: no hay con qué validar. Si NO hay un comprobante con datos leídos
      // (monto/op/código) NI el cliente dio nombre/código, el modelo está intentando
      // validar sin que haya pago real (típico: el cliente mandó una imagen que NO es
      // comprobante estando en contexto de pago). NO le pidas el titular en automático
      // (eso confunde y mete en bucle); deja que el agente decida por contexto.
      const hasReceiptData = !!(
        ctx.state.lastReceipt &&
        (ctx.state.lastReceipt.operationNumber ||
          ctx.state.lastReceipt.amountText ||
          ctx.state.lastReceipt.securityCode)
      );
      if (!hasReceiptData && !payerName && !codes.length) {
        return JSON.stringify({
          ok: false,
          error:
            "El cliente todavía no envió un comprobante de pago ni datos del titular. NO valides ni le pidas automáticamente el nombre del titular. " +
            "Si envió una imagen que NO es un comprobante, conversa normal sobre ella según el contexto de la conversación. " +
            "Si dice que ya pagó, pídele con naturalidad que te mande la CAPTURA del comprobante (o, si paga por Plin, el nombre del titular de su Yape/Plin).",
        });
      }

      // Monto esperado (para el match y el recheck).
      const cartVp = await summarizeCart(ctx.companyId, ctx.customerId);
      let expectedVp: number | undefined = cartVp.total > 0 ? cartVp.total : undefined;
      if (expectedVp === undefined && ctx.state.selectedProductId) {
        const p = findProductById(ctx, ctx.state.selectedProductId);
        const n = Number(String(p?.price ?? "").replace(/[^0-9.]/g, ""));
        if (Number.isFinite(n) && n > 0) expectedVp = n;
      }

      const result = await tryApprovePayment({
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        customerPhone: ctx.customerPhone,
        config: ctx.config,
        state: ctx.state,
        payerName: payerName || undefined,
        codes,
        expected: expectedVp,
        deliver: false, // el modelo entrega con entregar_producto
      });

      if (result.approved) {
        if (result.kind === "already") {
          if (result.customerMessage) ctx.outbox.push({ kind: "text", text: result.customerMessage });
          return JSON.stringify({ ok: true, approved: true, note: "El pago ya estaba confirmado. NO vuelvas a entregar ni a validar. Ya le avisé al cliente; deja tu texto final vacío." });
        }
        return JSON.stringify({ ok: true, approved: true, note: "Pago aprobado. Ahora entrega el producto con entregar_producto." });
      }

      // TIMING (hay un dato pero el comprobante aún no entró): reintento en 2º plano
      // a +60s; si no aparece, el worker deriva a un asesor. Mensaje tranquilizador.
      if (result.kind === "timing") {
        if (result.customerMessage) ctx.outbox.push({ kind: "text", text: result.customerMessage });
        const recheckedRecently =
          ctx.state.pendingRecheckAt &&
          Date.now() - new Date(ctx.state.pendingRecheckAt).getTime() < 3 * 60 * 1000;
        if (!recheckedRecently) {
          await schedulePaymentRecheck({
            companyId: ctx.companyId,
            customerId: ctx.customerId,
            conversationId: ctx.conversationId,
            sendAt: new Date(Date.now() + 60 * 1000),
            payerName: payerName || undefined,
            expectedAmount: expectedVp,
            operationCode: codes[0],
            customerPhone: ctx.customerPhone,
            receiptMediaUrl: ctx.state.lastReceipt?.mediaUrl ?? undefined,
          });
          ctx.state.pendingRecheckAt = new Date().toISOString();
        }
        return JSON.stringify({ ok: true, approved: false, kind: "timing", note: "Ya le respondí al cliente (estoy validando). NO agregues texto ni apruebes; deja tu texto final vacío." });
      }

      // FALTA DATO (confusión / sin nombre / monto distinto): pedir el dato al
      // cliente, pero SIN insistir mucho — tras 3 intentos sin lograrlo, derivar a
      // un asesor (no hacer dar vueltas al cliente).
      const attempts = (Number(ctx.state.paymentAttempts) || 0) + 1;
      ctx.state.paymentAttempts = attempts;
      if (attempts >= 3) {
        ctx.state.status = "ASESOR_HUMANO";
        ctx.state.pendingAction = "HUMAN: no se pudo validar el pago automáticamente (3 intentos)";
        ctx.state.paymentAttempts = 0;
        ctx.outbox.push({
          kind: "text",
          text: "Voy a pasar tu caso a un asesor para validar tu pago cuanto antes 🙏 En un momentito te confirma. ¡Gracias por tu paciencia!",
        });
        return JSON.stringify({ ok: true, approved: false, derived: true, note: "Derivado a un asesor tras 3 intentos de validación. Deja tu texto final vacío." });
      }
      if (result.customerMessage) ctx.outbox.push({ kind: "text", text: result.customerMessage });
      return JSON.stringify({ ok: true, approved: false, kind: result.kind, note: "Ya le respondí al cliente pidiéndole el dato para validar. NO agregues texto ni apruebes; deja tu texto final vacío." });
    }

    case "entregar_producto": {
      // Idempotencia: si ya se entregó (p.ej. la auto-validación de la imagen ya
      // entregó), no volver a enviar el acceso.
      if (!ctx.simulate && ctx.state.status === "ENTREGADO") {
        return JSON.stringify({ ok: true, alreadyDelivered: true, note: "El acceso YA se entregó. NO lo reenvíes; deja tu texto final vacío y queda disponible para dudas." });
      }
      // En SIMULACIÓN no hay PaymentReceipt real: entregar según carrito/seleccionado.
      let ids: string[];
      if (ctx.simulate) {
        // Preferir el combo capturado al validar el pago (el carrito ya se cerró en sim).
        const pending = ctx.state.pendingDeliveryProductIds ?? [];
        const cartSim = await summarizeCart(ctx.companyId, ctx.customerId);
        ids = pending.length
          ? pending
          : cartSim.productIds.length
          ? cartSim.productIds
          : ctx.state.selectedProductId
          ? [ctx.state.selectedProductId]
          : [];
        ctx.state.pendingDeliveryProductIds = [];
        if (!ids.length) {
          return JSON.stringify({ ok: false, error: "(simulación) No hay un producto seleccionado para entregar." });
        }
      } else {
        // Verificar que exista un pago aprobado reciente para este cliente
        const approved = await prisma.paymentReceipt.findFirst({
          where: { companyId: ctx.companyId, customerId: ctx.customerId, status: "APROBADO" },
          orderBy: { validatedAt: "desc" },
          select: { id: true, productIds: true, productId: true },
        });
        if (!approved) {
          return JSON.stringify({ ok: false, error: "No hay un pago aprobado para este cliente. No entregues nada todavía." });
        }
        ids = approved.productIds?.length
          ? approved.productIds
          : approved.productId
          ? [approved.productId]
          : ctx.state.selectedProductId
          ? [ctx.state.selectedProductId]
          : [];
      }

      const cartForPlan = await summarizeCart(ctx.companyId, ctx.customerId);
      const del = await assignAndBuildDelivery(ctx.config, ids, {
        companyId: ctx.companyId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        planByProduct: planByProductFromCart(cartForPlan),
        simulate: ctx.simulate,
      });
      const { delivered, offeredCatalog, shouldPauseHuman, manualNeeded, outOfStock } = del;
      ctx.outbox.push(...del.outbox);
      // Aclaración en el simulador: la credencial mostrada es una vista previa real del
      // inventario, pero NO se consumió stock (en real sí se asigna y baja el stock).
      if (
        ctx.simulate &&
        delivered.length &&
        ids.some((id) => (findProductById(ctx, id)?.digitalDelivery as { assignmentMode?: string } | null)?.assignmentMode === "POOL_AUTO")
      ) {
        ctx.adminNotices.push(
          "🔎 (Simulación) Mostré una credencial REAL de tu inventario como vista previa; NO se consumió stock. En real, esa cuenta se asigna al cliente y el stock baja.",
        );
      }
      const offeredCrossSell = Boolean(del.offeredCrossSellId);
      if (del.offeredCrossSellId) {
        // Contexto para el siguiente turno: el agente sabe qué producto ofreció.
        ctx.state.offeredCrossSellProductId = del.offeredCrossSellId;
      }
      if (!delivered.length && !manualNeeded.length) {
        return JSON.stringify({ ok: false, error: "No se encontró entrega digital configurada para el producto pagado." });
      }
      const needsHandoff = manualNeeded.length > 0;
      // Si todo quedó manual (nada entregado automático), el estado no es ENTREGADO.
      ctx.state.status = delivered.length ? "ENTREGADO" : "PAGADO";

      // Aviso al dueño por cada venta automática (entrega por inventario).
      for (const s of del.autoSales) {
        ctx.adminNotices.push(autoSaleNotice(s, ctx.customerPhone));
      }

      // Suscripciones de vencimiento (solo productos STREAMER con duración; no en simulación).
      if (!ctx.simulate) {
        await registerStreamingSubscriptions({
          config: ctx.config,
          companyId: ctx.companyId,
          customerId: ctx.customerId,
          conversationId: ctx.conversationId,
          productIds: ids,
          planByProduct: planByProductFromCart(cartForPlan),
        });
      }

      // Acciones de venta configuradas por producto: mover al cliente a una pestaña
      // del CRM y/o asignarle etiquetas (best-effort, no rompe la entrega).
      if (!ctx.simulate) {
        for (const pid of ids) {
          const dd = findProductById(ctx, pid)?.digitalDelivery;
          if (dd && (dd.onSaleCrmId || (dd.onSaleTagIds && dd.onSaleTagIds.length))) {
            await applyCrmAndTagActions(ctx.companyId, ctx.customerId, {
              tagIds: dd.onSaleTagIds,
              crmId: dd.onSaleCrmId,
              crmColumnId: dd.onSaleCrmColumnId,
            });
          }
        }
      }

      // Entrega MANUAL / sin stock: pasar el chat a atención humana y avisar al asesor.
      if (needsHandoff) {
        if (ctx.simulate) {
          ctx.adminNotices.push(
            `🔇 (Simulación) ${manualNeeded.join(", ")} requiere entrega manual${outOfStock.length ? " (SIN STOCK en inventario)" : ""}; el chat pasaría a atención humana.`,
          );
        } else {
          ctx.state.status = "ASESOR_HUMANO";
          ctx.state.pendingAction =
            `Entrega manual pendiente: ${manualNeeded.join(", ")}` +
            (outOfStock.length ? ` · SIN STOCK: ${outOfStock.join(", ")}` : "");
        }
      } else if (ctx.simulate) {
        // En el simulador NO se mutea de verdad (no tocamos mutedNumbers ni pausamos).
        if (shouldPauseHuman) {
          ctx.adminNotices.push("🔇 (Simulación) Aquí el chat pasaría a atención humana porque el producto tiene activado “pasar a humano tras vender”. En real el bot dejaría de responder a este cliente.");
        }
      } else if (shouldPauseHuman || !offeredCrossSell) {
        await maybeMuteAfterSale(ctx, { forced: shouldPauseHuman });
      }

      // El recordatorio post-venta se programa automáticamente (plantilla configurada).
      const notaEntrega = needsHandoff
        ? "Le confirmé el pago y avisé que un asesor le enviará el acceso pendiente en breve. El chat pasa a atención humana: NO ofrezcas nada más ni agregues cierre. Deja tu texto final VACÍO."
        : shouldPauseHuman
        ? "Ya entregué el acceso y los mensajes configurados. Este producto pasa a atención humana tras la venta: NO ofrezcas más productos ni el catálogo, NO agregues cierre ni 'gracias por tu compra'. Deja tu texto final VACÍO; un asesor humano continúa desde aquí."
        : offeredCrossSell
        ? "Ya entregué el acceso, los mensajes adicionales y al final ofrecí otro producto con una pregunta abierta ('¿Te cuento más?'). NO agregues ningún cierre ni 'gracias por tu compra': deja tu texto final VACÍO para que la conversación quede ABIERTA en esa oferta y el cliente pueda responder."
        : offeredCatalog
        ? "Ya entregué el acceso y los mensajes adicionales, y al final invité al cliente a ver el resto del catálogo. NO agregues ningún cierre ni 'gracias por tu compra': deja tu texto final VACÍO. Si el cliente acepta ('sí', 'muéstrame'), usa enviar_catalogo en el siguiente turno."
        : "Ya entregué el acceso y los mensajes adicionales configurados (suelen incluir el saludo/agradecimiento). NO repitas el link ni vuelvas a agradecer; deja tu texto final VACÍO. Mantente disponible, no cierres la conversación.";
      return JSON.stringify({
        ok: true,
        delivered,
        manualNeeded,
        offeredCrossSell,
        offeredCatalog,
        nota: notaEntrega,
      });
    }

    case "registrar_pedido": {
      const product = findProductById(ctx, String(args.productId ?? ""));
      if (!product) return JSON.stringify({ ok: false, error: "producto no encontrado" });
      if (product.productType !== "physical") {
        return JSON.stringify({ ok: false, error: "registrar_pedido es solo para productos físicos" });
      }
      if (ctx.simulate) {
        ctx.state.status = "PEDIDO_REGISTRADO";
        ctx.state.selectedProductId = product.id;
        return JSON.stringify({ ok: true, orderCode: "SIM-0001", note: "(simulación) Pedido registrado. Confirma al cliente con el código y los próximos pasos." });
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
      if (ctx.simulate) {
        await checkoutCart(ctx.companyId, ctx.customerId, cart.totalText);
        ctx.state.status = "PEDIDO_REGISTRADO";
        return JSON.stringify({ ok: true, orderCode: "SIM-0001", total: cart.totalText, note: "(simulación) Pedido registrado. Confirma con el código y el total." });
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
      if (ctx.simulate) {
        ctx.state.status = "RESERVA_SOLICITADA";
        ctx.state.selectedProductId = product.id;
        return JSON.stringify({ ok: true, bookingId: "SIM-0001", note: "(simulación) Reserva registrada. Un asesor confirmará el horario." });
      }
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
