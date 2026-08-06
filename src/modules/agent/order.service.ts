/**
 * Registro de pedidos del rubro Comercial (y Restaurante) desde el agente.
 * Crea un `Order` multi-ítem (OrderItem[]) con orderCode único, historial de
 * estado inicial, total y estado de pago según el modo de cobro. Emite un
 * evento realtime al panel. El admin gestiona el estado desde la página Pedidos.
 */

import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { renderCartForOrder, variantLabelFor, type CartSummary } from "./cart.service";

type PaymentMode = "BEFORE_DELIVERY" | "CASH_ON_DELIVERY" | "MANUAL";

// Código corto y legible: PED-<base36 del tiempo>. Se pasa el timestamp desde el
// caller (Date.now en backend es válido) para mantenerlo puro.
function buildOrderCode(seed: number): string {
  const t = seed.toString(36).toUpperCase().slice(-6);
  const r = Math.floor((seed % 1000) + (seed % 97)).toString(36).toUpperCase().slice(-2);
  return `PED-${t}${r}`;
}

function parseNum(v: string | null | undefined): number {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Estado inicial del pedido según cómo cobra el negocio. */
function initialStatusFor(mode: PaymentMode | undefined): {
  status: "PEDIDO_REGISTRADO" | "PENDIENTE_PAGO" | "EN_COORDINACION";
  paymentStatus: string;
} {
  // Contra entrega: el pedido queda por coordinar la entrega (se cobra al entregar).
  if (mode === "CASH_ON_DELIVERY") return { status: "EN_COORDINACION", paymentStatus: "PENDIENTE_PAGO" };
  // Pago adelantado / manual: pendiente de pago hasta que se confirme.
  if (mode === "BEFORE_DELIVERY" || mode === "MANUAL") {
    return { status: "PENDIENTE_PAGO", paymentStatus: "PENDIENTE_PAGO" };
  }
  return { status: "PEDIDO_REGISTRADO", paymentStatus: "PENDIENTE_PAGO" };
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
  const lineTotal = `S/ ${(parseNum(unit) * qty).toFixed(2)}`;
  const init = initialStatusFor(input.paymentMode);

  const order = await prisma.order.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      productId: input.productId,
      orderCode: buildOrderCode(Date.now()),
      quantity: qty,
      customerName: input.customerName.trim(),
      address: input.address.trim(),
      reference: (input.reference ?? "").trim(),
      notes: input.notes?.trim() || null,
      status: init.status,
      paymentStatus: init.paymentStatus,
      total: lineTotal,
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
  });

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
}) {
  if (!input.cart.items.length) throw new AppError("El carrito está vacío", 422);

  const firstProductId = input.cart.items[0].productId;
  const totalQty = input.cart.items.reduce((acc, it) => acc + it.quantity, 0);
  const notes = [input.extraNotes?.trim(), renderCartForOrder(input.cart)].filter(Boolean).join("\n");
  const init = initialStatusFor(input.paymentMode);

  const order = await prisma.order.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      productId: firstProductId,
      orderCode: buildOrderCode(Date.now()),
      quantity: totalQty,
      customerName: input.customerName.trim(),
      address: input.address.trim(),
      reference: (input.reference ?? "").trim(),
      notes,
      status: init.status,
      paymentStatus: init.paymentStatus,
      total: input.cart.totalText,
      items: {
        create: input.cart.items.map((it) => ({
          productId: it.productId,
          productName: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPriceText ?? `S/ ${it.unitPrice.toFixed(2)}`,
          variantLabel: variantLabelFor(it) || null,
          lineTotal: `S/ ${(it.unitPrice * it.quantity).toFixed(2)}`,
        })),
      },
      statusHistory: { create: [{ toStatus: init.status, changedBy: "agente", note: "Pedido registrado" }] },
    },
    include: { product: { select: { name: true } } },
  });

  emitOrderNew(input.companyId, order);
  return order;
}
