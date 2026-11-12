/**
 * Registro de pedidos del rubro Comercial (y Restaurante) desde el agente.
 * Crea un `Order` multi-ítem (OrderItem[]) con orderCode único, historial de
 * estado inicial, total y estado de pago según el modo de cobro. Emite un
 * evento realtime al panel. El admin gestiona el estado desde la página Pedidos.
 */

import { prisma } from "../../lib/prisma";
import { symbolFor } from "../../lib/currency";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { renderCartForOrder, variantLabelFor, type CartSummary } from "./cart.service";
import { toDec } from "../orders/order-money";
import type { DeliveryType, OrderAmounts } from "../shipping/shipping-config";

type PaymentMode = "BEFORE_DELIVERY" | "CASH_ON_DELIVERY" | "MANUAL";

// Código corto y legible: PED-<base36 del tiempo>. Se pasa el timestamp desde el
// caller (Date.now en backend es válido) para mantenerlo puro.
function buildOrderCode(seed: number): string {
  const t = seed.toString(36).toUpperCase().slice(-6);
  const r = Math.floor((seed % 1000) + (seed % 97)).toString(36).toUpperCase().slice(-2);
  return `PED-${t}${r}`;
}

/**
 * `orderCode` es único y sale del reloj: dos pedidos en el mismo milisegundo (un pedido
 * del chat y otro de la tienda web) chocarían. Se reintenta con otra semilla.
 */
async function withOrderCode<T>(create: (orderCode: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await create(buildOrderCode(Date.now() + attempt * 7919));
    } catch (err) {
      const duplicated = (err as { code?: string }).code === "P2002";
      if (!duplicated || attempt >= 3) throw err;
    }
  }
}

function parseNum(v: string | null | undefined): number {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Estado inicial y método de pago legible del pedido según cómo cobra el negocio. */
function initialStatusFor(mode: PaymentMode | undefined): {
  status: "PEDIDO_REGISTRADO" | "PENDIENTE_PAGO" | "EN_COORDINACION";
  paymentStatus: string;
  paymentMethod: string | null;
} {
  // Contra entrega: el pedido queda por coordinar la entrega (se cobra al entregar).
  if (mode === "CASH_ON_DELIVERY") {
    return { status: "EN_COORDINACION", paymentStatus: "PENDIENTE_PAGO", paymentMethod: "Contra entrega" };
  }
  // Pago adelantado / manual: pendiente de pago hasta que se confirme.
  if (mode === "BEFORE_DELIVERY") {
    return { status: "PENDIENTE_PAGO", paymentStatus: "PENDIENTE_PAGO", paymentMethod: "Pago adelantado" };
  }
  if (mode === "MANUAL") {
    return { status: "PENDIENTE_PAGO", paymentStatus: "PENDIENTE_PAGO", paymentMethod: "Coordinación manual" };
  }
  return { status: "PEDIDO_REGISTRADO", paymentStatus: "PENDIENTE_PAGO", paymentMethod: null };
}

/**
 * Envío y montos del pedido cuando el negocio tiene «Envíos» encendido. Los montos los
 * calcula quien llama (computeOrderAmounts) con la configuración del negocio.
 */
export interface OrderShippingInput {
  amounts: OrderAmounts;
  deliveryType: DeliveryType;
  courier?: string | null;
  agencyId?: string | null;
  agencyName?: string | null;
  agencyAddress?: string | null;
  recipientDocument?: string | null;
  recipientPhone?: string | null;
}

/** Estado inicial según la regla de cobro del tipo de entrega. */
function initialStatusForShipping(shipping: OrderShippingInput, mode: PaymentMode | undefined): ReturnType<typeof initialStatusFor> {
  const { chargeMode, advance } = shipping.amounts;
  if (chargeMode === "TOTAL") {
    return { status: "PENDIENTE_PAGO", paymentStatus: "PENDIENTE_PAGO", paymentMethod: "Pago adelantado" };
  }
  if (chargeMode === "ADELANTO") {
    return {
      status: advance > 0 ? "PENDIENTE_PAGO" : "EN_COORDINACION",
      paymentStatus: "PENDIENTE_PAGO",
      paymentMethod: "Adelanto y saldo",
    };
  }
  // Sin cobro previo: coordinación manual conserva su estado de siempre.
  if (mode === "MANUAL") return initialStatusFor(mode);
  return { status: "EN_COORDINACION", paymentStatus: "PENDIENTE_PAGO", paymentMethod: "Contra entrega" };
}

/** Columnas de envío y montos del pedido. Vacío sin «Envíos»: el pedido queda como siempre. */
function shippingColumns(shipping: OrderShippingInput | undefined, symbol: string) {
  if (!shipping) return {};
  const a = shipping.amounts;
  const text = (v: string | null | undefined) => v?.trim() || null;
  return {
    deliveryType: shipping.deliveryType,
    courier: text(shipping.courier)?.toUpperCase() ?? null,
    agencyId: shipping.agencyId ?? null,
    agencyName: text(shipping.agencyName),
    agencyAddress: text(shipping.agencyAddress),
    recipientDocument: text(shipping.recipientDocument),
    recipientPhone: text(shipping.recipientPhone),
    subtotalAmount: toDec(a.subtotal),
    shippingAmount: toDec(a.shipping),
    totalAmount: toDec(a.total),
    advanceAmount: toDec(a.advance),
    paidAmount: toDec(0),
    total: `${symbol} ${a.total.toFixed(2)}`,
  };
}

/** `Order.address` es obligatorio: en agencia o recojo se arma con lo que se sabe. */
function addressFor(address: string, shipping: OrderShippingInput | undefined): string {
  const typed = address.trim();
  if (typed || !shipping) return typed;
  if (shipping.deliveryType === "RECOJO") return "Recojo en tienda";
  if (shipping.deliveryType === "AGENCIA") {
    return [shipping.agencyName?.trim(), shipping.agencyAddress?.trim()].filter(Boolean).join(" · ") || "Agencia por confirmar";
  }
  return typed;
}

function emitOrderNew(
  companyId: string,
  order: { id: string; orderCode: string; status: string; customerName: string; product?: { name: string } | null },
) {
  socketService.emitToCompany(companyId, SOCKET_EVENTS.ORDER_NEW, {
    id: order.id,
    orderCode: order.orderCode,
    status: order.status,
    customerName: order.customerName,
    product: order.product?.name,
  });
}

export interface CreateOrderInput {
  companyId: string;
  customerId: string;
  productId: string;
  quantity: number;
  customerName: string;
  address: string;
  reference?: string;
  notes?: string;
  /** Variante elegida (talla/color) para el snapshot del ítem. */
  variantLabel?: string;
  paymentMode?: PaymentMode;
  /** Solo con «Envíos» encendido: datos de envío y montos (total, adelanto). */
  shipping?: OrderShippingInput;
}

export async function createAgentOrder(input: CreateOrderInput) {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, companyId: input.companyId, active: true },
    select: { id: true, name: true, price: true, productType: true },
  });
  if (!product) throw new AppError("Producto no encontrado o inactivo", 404);
  if (product.productType !== "PHYSICAL") {
    throw new AppError("Solo se registran pedidos para productos físicos", 422);
  }

  const qty = Math.max(1, input.quantity || 1);
  const unit = product.price ?? "0";
  const company = await prisma.company.findUnique({ where: { id: input.companyId }, select: { currency: true } });
  const symbol = symbolFor(company?.currency);
  const lineTotal = `${symbol} ${(parseNum(unit) * qty).toFixed(2)}`;
  const init = input.shipping ? initialStatusForShipping(input.shipping, input.paymentMode) : initialStatusFor(input.paymentMode);

  const order = await withOrderCode((orderCode) => prisma.order.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      productId: input.productId,
      orderCode,
      quantity: qty,
      customerName: input.customerName.trim(),
      address: addressFor(input.address, input.shipping),
      reference: (input.reference ?? "").trim(),
      notes: input.notes?.trim() || null,
      status: init.status,
      paymentStatus: init.paymentStatus,
      paymentMethod: init.paymentMethod,
      total: lineTotal,
      ...shippingColumns(input.shipping, symbol),
      items: {
        create: [
          {
            productId: product.id,
            productName: product.name,
            quantity: qty,
            unitPrice: unit,
            variantLabel: input.variantLabel?.trim() || null,
            lineTotal,
          },
        ],
      },
      statusHistory: { create: [{ toStatus: init.status, changedBy: "agente", note: "Pedido registrado" }] },
    },
    include: { product: { select: { name: true } } },
  }));

  emitOrderNew(input.companyId, order);
  return order;
}

/**
 * Crea UN pedido a partir del carrito completo, con un OrderItem por línea
 * (snapshot de nombre/precio/variante). El aplanado a `notes` se conserva como
 * respaldo legible.
 */
export async function createOrderFromCart(input: {
  companyId: string;
  customerId: string;
  cart: CartSummary;
  customerName: string;
  address: string;
  reference?: string;
  extraNotes?: string;
  paymentMode?: PaymentMode;
  /** Solo con «Envíos» encendido: datos de envío y montos (total, adelanto). */
  shipping?: OrderShippingInput;
  /** Quién registra el pedido en el historial. Por defecto "agente". */
  changedBy?: string;
  /** Origen del pedido: "WEB" = tienda web. Vacío = chat (lo de siempre). */
  source?: string;
  /** Nota del primer registro del historial. */
  historyNote?: string;
}) {
  if (!input.cart.items.length) throw new AppError("El carrito está vacío", 422);

  const firstProductId = input.cart.items[0].productId;
  const totalQty = input.cart.items.reduce((acc, it) => acc + it.quantity, 0);
  const notes = [input.extraNotes?.trim(), renderCartForOrder(input.cart)].filter(Boolean).join("\n");
  const init = input.shipping ? initialStatusForShipping(input.shipping, input.paymentMode) : initialStatusFor(input.paymentMode);

  const order = await withOrderCode((orderCode) => prisma.order.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      productId: firstProductId,
      orderCode,
      source: input.source ?? null,
      quantity: totalQty,
      customerName: input.customerName.trim(),
      address: addressFor(input.address, input.shipping),
      reference: (input.reference ?? "").trim(),
      notes,
      status: init.status,
      paymentStatus: init.paymentStatus,
      paymentMethod: init.paymentMethod,
      total: input.cart.totalText,
      ...shippingColumns(input.shipping, input.cart.symbol),
      items: {
        create: input.cart.items.map((it) => ({
          productId: it.productId,
          productName: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPriceText ?? `${input.cart.symbol} ${it.unitPrice.toFixed(2)}`,
          variantLabel: variantLabelFor(it) || null,
          lineTotal: `${input.cart.symbol} ${(it.unitPrice * it.quantity).toFixed(2)}`,
        })),
      },
      statusHistory: {
        create: [{ toStatus: init.status, changedBy: input.changedBy ?? "agente", note: input.historyNote ?? "Pedido registrado" }],
      },
    },
    include: { product: { select: { name: true } } },
  }));

  emitOrderNew(input.companyId, order);
  return order;
}
