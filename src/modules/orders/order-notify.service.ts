/**
 * Avisos al cliente por WhatsApp cuando cambia su pedido (despachado, listo para
 * recoger, entregado, cancelado, adelanto recibido, pago completo).
 *
 * Cada evento tiene interruptor y plantilla en Empresa → Envíos → Avisos al cliente
 * (`shippingConfig.notifications`). Todo nace apagado: sin «Envíos» encendido o con el
 * evento apagado no sale nada. El envío pasa por la compuerta de envíos manuales (no
 * contactar, ventana de 24 h de Meta), lleva la firma y queda registrado en el chat;
 * si no se puede enviar, queda una nota interna en el chat con el motivo.
 */

import type { OrderStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { symbolFor } from "../../lib/currency";
import { applySpintax } from "../agent/reminder-templates";
import { checkManualSendGate } from "../agent/manual-send-gate";
import { loadWhatsappSender } from "../agent/outbound";
import {
  recordMessage,
  saveState,
  sendHumanReply,
  setBotPaused,
  type ConversationState,
} from "../agent/conversation.service";
import {
  NOTIFY_EVENT_LABELS,
  NOTIFY_VARIABLES,
  normalizeShippingConfig,
  shippingOn,
  type NotifyEvent,
  type ShippingConfig,
} from "../shipping/shipping-config";
import { storeOrderUrl } from "../storefront/storefront-url";
import { moneyOf } from "./order-money";

export const ORDER_NOTICE_SOURCE = "order-notice";

export type NoticeVars = Record<(typeof NOTIFY_VARIABLES)[number], string>;

export interface OrderNoticeResult {
  sent: boolean;
  event: NotifyEvent;
  /** Motivo legible cuando no se envió (el panel y el Copiloto lo muestran). */
  reason?: string;
}

/** Evento de aviso que corresponde a un cambio de estado (null = ese estado no avisa). */
export function noticeEventForStatus(status: OrderStatus | string): NotifyEvent | null {
  switch (status) {
    case "DESPACHADO":
    case "LISTO_PARA_RECOGER":
    case "ENTREGADO":
    case "CANCELADO":
      return status;
    case "PAGADO":
      return "PAGO_COMPLETO";
    default:
      return null;
  }
}

const VAR_RE = /\{([a-zA-Z]+)\}/g;

/**
 * Arma el texto del aviso: variantes `{Hola|Buenas}`, variables y limpieza. Una línea
 * cuyas variables quedaron TODAS vacías se quita entera (p. ej. «Guía: {guia}» sin guía),
 * así una plantilla sirve para todos los tipos de entrega.
 */
export function renderNoticeTemplate(template: string, vars: Record<string, string>): string {
  const known = new Map<string, string>(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  const lines = applySpintax(template)
    .split("\n")
    .map((line) => {
      let used = 0;
      let filled = 0;
      const out = line.replace(VAR_RE, (m, name: string) => {
        const value = known.get(name.toLowerCase());
        if (value === undefined) return m;
        used++;
        if (value) filled++;
        return value;
      });
      return used > 0 && filled === 0 ? null : out.replace(/[ \t]{2,}/g, " ").trimEnd();
    })
    .filter((l): l is string => l !== null);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function renderOrderNotice(template: string, vars: NoticeVars): string {
  return renderNoticeTemplate(template, vars);
}

interface NoticeOrder {
  orderCode: string;
  status: OrderStatus;
  customerName: string;
  total: string | null;
  totalAmount: unknown;
  advanceAmount: unknown;
  paidAmount: unknown;
  courier: string | null;
  agencyName: string | null;
  agencyAddress: string | null;
  trackingCode: string | null;
  pickupKey: string | null;
}

/** La clave de recojo solo viaja cuando la configuración ya permite entregarla. */
export function releasedPickupKey(
  order: { pickupKey: string | null; status: OrderStatus | string },
  cfg: ShippingConfig,
  balance: number | null,
): string {
  if (!order.pickupKey) return "";
  if (cfg.pickupKeyRelease === "AL_PAGAR_SALDO") return balance !== null && balance <= 0.005 ? order.pickupKey : "";
  return ["DESPACHADO", "LISTO_PARA_RECOGER", "ENTREGADO"].includes(order.status) ? order.pickupKey : "";
}

export function noticeVarsFor(
  order: NoticeOrder,
  cfg: ShippingConfig,
  symbol: string,
  customerName?: string | null,
  /** Enlace a la página del pedido (solo los pedidos de la tienda web la tienen). */
  trackingUrl?: string | null,
): NoticeVars {
  const money = moneyOf(order as Parameters<typeof moneyOf>[0]);
  const fmt = (n: number) => `${symbol} ${n.toFixed(2)}`;
  const name = (customerName || order.customerName || "").trim().split(/\s+/)[0] ?? "";
  return {
    nombre: name,
    pedido: order.orderCode,
    total: money ? fmt(money.total) : (order.total ?? ""),
    pagado: money && money.paid > 0.005 ? fmt(money.paid) : "",
    saldo: money && money.balance > 0.005 ? fmt(money.balance) : "",
    agencia: order.agencyName ?? "",
    direccionAgencia: order.agencyAddress ?? "",
    guia: order.trackingCode ?? "",
    clave: releasedPickupKey(order, cfg, money ? money.balance : null),
    courier: order.courier ?? "",
    seguimiento: trackingUrl ?? "",
  };
}

async function chatOf(companyId: string, customerId: string) {
  return prisma.conversation.findFirst({
    where: { companyId, customerId, channel: { in: ["whatsapp", "web"] } },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, channel: true, botPaused: true, state: true, customer: { select: { name: true, optOutAt: true } } },
  });
}

/**
 * Envía al cliente el aviso de un evento del pedido si el negocio lo tiene encendido.
 * Nunca lanza: devuelve si salió y, si no, por qué.
 */
export async function notifyOrderEvent(companyId: string, orderId: string, event: NotifyEvent): Promise<OrderNoticeResult> {
  const skipped = (reason: string): OrderNoticeResult => ({ sent: false, event, reason });
  try {
    const [company, order, webOrder] = await Promise.all([
      prisma.company.findUnique({ where: { id: companyId }, select: { currency: true, shippingConfig: true, slug: true } }),
      prisma.order.findFirst({
        where: { id: orderId, companyId },
        select: {
          customerId: true,
          orderCode: true,
          status: true,
          customerName: true,
          total: true,
          totalAmount: true,
          advanceAmount: true,
          paidAmount: true,
          courier: true,
          agencyName: true,
          agencyAddress: true,
          trackingCode: true,
          pickupKey: true,
        },
      }),
      // Pedido que nació en la tienda web: su página de seguimiento viaja en {seguimiento}.
      prisma.storeOrder.findFirst({ where: { orderId, companyId }, select: { id: true, accessToken: true } }),
    ]);
    if (!order) return skipped("pedido no encontrado");
    const cfg = normalizeShippingConfig(company?.shippingConfig);
    if (!shippingOn(cfg)) return skipped("«Envíos» está apagado");
    const rule = cfg.notifications[event];
    if (!rule.enabled) return skipped(`el aviso «${NOTIFY_EVENT_LABELS[event]}» está apagado`);
    if (!order.customerId) return skipped("el pedido no tiene cliente");

    const convo = await chatOf(companyId, order.customerId);
    if (!convo) return skipped("el cliente no tiene conversación");

    const trackingUrl = webOrder && company?.slug ? storeOrderUrl(company.slug, webOrder.id, webOrder.accessToken) : null;
    const text = renderOrderNotice(
      rule.message,
      noticeVarsFor(order, cfg, symbolFor(company?.currency), convo.customer.name, trackingUrl),
    );
    if (!text) return skipped("la plantilla del aviso quedó vacía");

    const note = (reason: string) =>
      recordMessage({
        companyId,
        customerId: order.customerId!,
        conversationId: convo.id,
        role: "SYSTEM",
        message: `📦 Aviso «${NOTIFY_EVENT_LABELS[event]}» del pedido ${order.orderCode} no enviado: ${reason}.`,
        rawPayload: { source: ORDER_NOTICE_SOURCE },
      }).catch(() => undefined);

    const provider = convo.channel === "web" ? "WEB" : ((await loadWhatsappSender(companyId))?.provider ?? null);
    if (!provider) {
      await note("no hay una cuenta de WhatsApp activa");
      return skipped("no hay una cuenta de WhatsApp activa");
    }
    // Aviso transaccional que dispara el dueño: respeta no contactar y la ventana de
    // 24 h, pero no espera el ritmo anti-bloqueo de los envíos del Copiloto.
    const gate = await checkManualSendGate({
      companyId,
      customerId: order.customerId,
      provider,
      optOutAt: convo.customer.optOutAt,
      skipPacing: true,
    });
    if (!gate.ok) {
      await note(gate.error);
      return skipped(gate.error);
    }
    try {
      await sendHumanReply(companyId, convo.id, text, { source: ORDER_NOTICE_SOURCE });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "falló el envío";
      await note(reason);
      return skipped(reason);
    }
    return { sent: true, event };
  } catch (err) {
    console.warn("[order-notify] aviso no enviado:", err instanceof Error ? err.message : err);
    return skipped("error interno al enviar el aviso");
  }
}

/**
 * Un pago registrado FUERA del chat (panel, Copiloto, comprobante aprobado a mano): deja
 * la conversación lista para seguir (sin revalidación pendiente; el bot vuelve si estaba
 * pausado por no poder validar el pago) y avisa al cliente. Dentro del chat confirma el
 * propio agente, así que ese camino no pasa por aquí.
 */
export async function afterOrderPaymentOutsideChat(
  companyId: string,
  orderId: string,
  opts: { fullyPaid: boolean },
): Promise<OrderNoticeResult> {
  const event: NotifyEvent = opts.fullyPaid ? "PAGO_COMPLETO" : "ADELANTO_RECIBIDO";
  try {
    const order = await prisma.order.findFirst({ where: { id: orderId, companyId }, select: { customerId: true } });
    const convo = order?.customerId ? await chatOf(companyId, order.customerId) : null;
    if (convo) {
      const state = ((convo.state as ConversationState | null) ?? {}) as ConversationState;
      const pausedByPayment = typeof state.pendingAction === "string" && state.pendingAction.startsWith("HUMAN[PAGO]");
      state.pendingRecheckAt = null;
      state.paymentAttempts = 0;
      state.lastReceipt = null;
      if (opts.fullyPaid) state.pendingOrderId = null;
      if (state.status !== "ASESOR_HUMANO") state.status = opts.fullyPaid ? "PAGADO" : "PEDIDO_REGISTRADO";
      await saveState(convo.id, state);
      if (convo.botPaused && pausedByPayment) await setBotPaused(companyId, convo.id, false);
    }
  } catch (err) {
    console.warn("[order-notify] no se pudo actualizar la conversación tras el pago:", err instanceof Error ? err.message : err);
  }
  return notifyOrderEvent(companyId, orderId, event);
}
