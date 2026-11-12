/**
 * Puente entre el pedido de la tienda web (StoreOrder: checkout y pago) y el pedido real
 * (Order: envío, adelanto, saldo, stock y avisos) de una tienda física.
 *
 * El StoreOrder guarda una foto de lo que el comprador eligió y de los montos calculados
 * en el checkout; el pedido real se crea a partir de esa foto, nunca recalculando: el
 * comprador recibe exactamente lo que vio aunque la configuración cambie después.
 */

import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { symbolFor } from "../../lib/currency";
import type { CartSummary } from "../agent/cart.service";
import { createOrderFromCart } from "../agent/order.service";
import type { OrderPayMode } from "../shipping/order-shipping-resolver";
import type { DeliveryType, OrderAmounts } from "../shipping/shipping-config";
import type { VariantChoice } from "./storefront-physical";

/** Foto de la entrega y los montos de un pedido web (`StoreOrder.shipping`). */
export type StoreShippingSnapshot = {
  deliveryType: DeliveryType;
  address: string;
  reference: string;
  courier: string | null;
  agencyId: string | null;
  agencyName: string | null;
  agencyAddress: string | null;
  document: string | null;
  recipientPhone: string | null;
  /** Elección del comprador cuando el negocio deja elegir cómo pagar. */
  cobro: "adelantado" | "contra_entrega" | null;
  paymentMode: OrderPayMode | null;
  amounts: OrderAmounts;
};

/** Línea de un pedido web físico (`StoreOrder.items`). */
export type StoreOrderLine = { productId: string; name: string; unitPrice: number; qty: number; variant: string | null; options: VariantChoice[] };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const DELIVERY_TYPES: DeliveryType[] = ["DOMICILIO", "AGENCIA", "RECOJO"];
const PAY_MODES: OrderPayMode[] = ["BEFORE_DELIVERY", "CASH_ON_DELIVERY", "MANUAL"];
const CHARGE_MODES: OrderAmounts["chargeMode"][] = ["TOTAL", "ADELANTO", "CONTRA_ENTREGA"];

/** Lee la foto de entrega de un StoreOrder. null = pedido digital o foto ilegible. */
export function shippingSnapshotOf(raw: unknown): StoreShippingSnapshot | null {
  const o = obj(raw);
  const deliveryType = DELIVERY_TYPES.find((t) => t === o.deliveryType);
  const a = obj(o.amounts);
  const chargeMode = CHARGE_MODES.find((m) => m === a.chargeMode);
  if (!deliveryType || !chargeMode) return null;
  const cobro = o.cobro === "adelantado" || o.cobro === "contra_entrega" ? o.cobro : null;
  return {
    deliveryType,
    address: str(o.address),
    reference: str(o.reference),
    courier: str(o.courier) || null,
    agencyId: str(o.agencyId) || null,
    agencyName: str(o.agencyName) || null,
    agencyAddress: str(o.agencyAddress) || null,
    document: str(o.document) || null,
    recipientPhone: str(o.recipientPhone) || null,
    cobro,
    paymentMode: PAY_MODES.find((m) => m === o.paymentMode) ?? null,
    amounts: {
      subtotal: num(a.subtotal),
      shipping: num(a.shipping),
      total: num(a.total),
      advance: num(a.advance),
      chargeMode,
      shippingPaidAtDestination: a.shippingPaidAtDestination === true,
    },
  };
}

/** Líneas de un pedido web con lo que el comprador eligió en la ficha (talla, color…). */
export function storeOrderLinesOf(raw: unknown): StoreOrderLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const o = obj(r);
      const options = Array.isArray(o.options)
        ? o.options.map((x) => ({ group: str(obj(x).group), option: str(obj(x).option) })).filter((x) => x.group && x.option)
        : [];
      return {
        productId: str(o.productId),
        name: str(o.name),
        unitPrice: num(o.unitPrice),
        qty: Math.max(1, Math.round(num(o.qty)) || 1),
        variant: str(o.variant) || null,
        options,
      };
    })
    .filter((l) => l.productId && l.name);
}

type LinkedOrder = { id: string; orderCode: string; status: string };

/**
 * Crea el pedido real de un pedido web físico y los enlaza. Idempotente: si el StoreOrder
 * ya tiene pedido devuelve ese; si dos llamadas coinciden, gana la que enlaza primero y la
 * otra borra el suyo. `created` dice si este llamado fue el que lo creó (para avisar una sola vez).
 */
export async function createOrderForStoreOrder(storeOrderId: string): Promise<LinkedOrder & { created: boolean }> {
  const so = await prisma.storeOrder.findUnique({
    where: { id: storeOrderId },
    select: { id: true, companyId: true, customerId: true, name: true, currency: true, items: true, shipping: true, metadata: true, orderId: true },
  });
  if (!so) throw new AppError("Pedido no encontrado", 404);
  const linked = async (): Promise<LinkedOrder | null> => {
    const row = await prisma.storeOrder.findUnique({ where: { id: so.id }, select: { order: { select: { id: true, orderCode: true, status: true } } } });
    return row?.order ?? null;
  };
  if (so.orderId) {
    const existing = await linked();
    if (existing) return { ...existing, created: false };
  }

  const snap = shippingSnapshotOf(so.shipping);
  const lines = storeOrderLinesOf(so.items);
  if (!snap || !lines.length) throw new AppError("El pedido de la tienda no tiene datos de entrega", 422);

  const symbol = symbolFor(so.currency);
  const money = (n: number) => `${symbol} ${n.toFixed(2)}`;
  // Carrito armado a mano: precios de lista por línea; los descuentos van en las notas y
  // el total de productos (ya con descuentos) es el subtotal del pedido.
  const cart: CartSummary = {
    cartId: `web:${so.id}`,
    items: lines.map((l, i) => ({
      itemId: `web:${so.id}:${i}`,
      productId: l.productId,
      name: l.name,
      quantity: l.qty,
      unitPriceText: money(l.unitPrice),
      unitPrice: l.unitPrice,
      modifiers: l.options.map((o) => ({ group: o.group, option: o.option, priceDelta: 0 })),
    })),
    total: snap.amounts.subtotal,
    totalText: money(snap.amounts.subtotal),
    productIds: Array.from(new Set(lines.map((l) => l.productId))),
    symbol,
  };
  const pricing = obj(obj(so.metadata).pricing);
  const combo = obj(pricing.combo);
  const coupon = obj(pricing.coupon);
  const extraNotes = [
    "Pedido de la tienda web",
    num(combo.discount) > 0 ? `Descuento${str(combo.label) ? ` (${str(combo.label)})` : ""}: -${money(num(combo.discount))}` : "",
    num(coupon.discount) > 0 ? `Cupón ${str(coupon.code)}: -${money(num(coupon.discount))}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const order = await createOrderFromCart({
    companyId: so.companyId,
    customerId: so.customerId,
    cart,
    customerName: so.name,
    address: snap.address,
    reference: snap.reference,
    extraNotes,
    paymentMode: snap.paymentMode ?? undefined,
    shipping: {
      amounts: snap.amounts,
      deliveryType: snap.deliveryType,
      courier: snap.courier,
      agencyId: snap.agencyId,
      agencyName: snap.agencyName,
      agencyAddress: snap.agencyAddress,
      recipientDocument: snap.document,
      recipientPhone: snap.recipientPhone,
    },
    changedBy: "tienda web",
    source: "WEB",
    historyNote: "Pedido de la tienda web",
  });

  const claim = await prisma.storeOrder.updateMany({ where: { id: so.id, orderId: null }, data: { orderId: order.id } });
  if (claim.count === 0) {
    // Otra llamada enlazó primero: este pedido sobra.
    await prisma.order.delete({ where: { id: order.id } }).catch(() => undefined);
    const existing = await linked();
    if (existing) return { ...existing, created: false };
    throw new AppError("No se pudo registrar el pedido", 500);
  }
  return { id: order.id, orderCode: order.orderCode, status: order.status, created: true };
}
