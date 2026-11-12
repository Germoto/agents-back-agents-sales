import { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { symbolFor } from "../../lib/currency";
import { findAgencyById } from "../shipping/agency-search";
import { parseDeliveryType } from "../shipping/shipping-config";
import { applyOrderPayment, mapOrder, moneyOf, toDec, type PaymentKind, type PaymentSource } from "./order-money";
import { afterOrderPaymentOutsideChat, noticeEventForStatus, notifyOrderEvent, type OrderNoticeResult } from "./order-notify.service";

const ORDER_INCLUDE = {
  customer: true,
  product: { select: { id: true, slug: true, name: true } },
  items: { orderBy: { createdAt: "asc" as const } },
  statusHistory: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.OrderInclude;

export async function listOrders(companyId: string) {
  const orders = await prisma.order.findMany({
    where: { companyId },
    include: ORDER_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  return orders.map((o) => mapOrder(o));
}

export async function getOrderDetail(companyId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, companyId },
    include: { ...ORDER_INCLUDE, payments: { orderBy: { createdAt: "asc" as const } } },
  });
  if (!order) throw new AppError("Pedido no encontrado", 404);
  // Comprobante de pago vinculado (por el campo suelto orderId del receipt).
  const receipt = await prisma.paymentReceipt.findFirst({
    where: { companyId, orderId },
    select: { id: true, status: true, amountPaid: true, paymentSource: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return { ...mapOrder(order), receipt };
}

/** Estados que representan que el pedido ya se pagó/salió/entregó (descuentan stock). */
const FULFILLED_STATUSES: OrderStatus[] = ["DESPACHADO", "LISTO_PARA_RECOGER", "ENTREGADO", "PAGADO"];

/**
 * Cambia el estado de un pedido (transición LIBRE) registrando el historial.
 * Al pasar a un estado de cumplimiento (pagado/despachado/entregado) descuenta
 * el stock de los productos UNA sola vez (idempotente por estado previo), si el
 * negocio controla stock.
 */
export async function updateOrderStatus(
  companyId: string,
  orderId: string,
  status: OrderStatus,
  opts: { changedBy?: string | null; note?: string | null; paymentSource?: PaymentSource; notify?: boolean } = {},
) {
  const current = await prisma.order.findFirst({
    where: { id: orderId, companyId },
    include: { items: { select: { productId: true, quantity: true } } },
  });
  if (!current) throw new AppError("Pedido no encontrado", 404);
  if (current.status === status) return { ...mapOrder(current), notice: undefined as OrderNoticeResult | undefined };
  // Pedido con montos que se marca PAGADO a mano con saldo pendiente: el saldo queda
  // anotado como un pago, para que pagado y saldo sigan cuadrando.
  const money = moneyOf(current);
  const settleBalance = status === "PAGADO" && money && money.balance > 0.005 ? money : null;

  const trackStock = await companyTracksStock(companyId);
  // Descontar stock solo si ANTES no estaba cumplido y AHORA sí (evita doble descuento).
  const shouldDeduct =
    trackStock && !FULFILLED_STATUSES.includes(current.status) && FULFILLED_STATUSES.includes(status);

  const updated = await prisma.$transaction(async (tx) => {
    if (shouldDeduct) {
      for (const it of current.items) {
        if (!it.productId) continue;
        await tx.product.updateMany({
          where: { id: it.productId, companyId, stock: { not: null } },
          data: { stock: { decrement: it.quantity } },
        });
      }
      // Clamp: ningún stock negativo.
      await tx.$executeRaw`UPDATE "Product" SET "stock" = 0 WHERE "companyId"::text = ${companyId} AND "stock" < 0`;
    }
    if (settleBalance) {
      await tx.orderPayment.create({
        data: {
          companyId,
          orderId,
          amount: toDec(settleBalance.balance),
          kind: settleBalance.paid > 0.005 ? "SALDO" : "TOTAL",
          source: opts.paymentSource ?? "PANEL",
          note: "Marcado como pagado",
          createdBy: opts.changedBy ?? null,
        },
      });
    }
    const order = await tx.order.update({
      where: { id: orderId },
      data: {
        status,
        ...(status === "PAGADO" ? { paymentStatus: "PAGADO" } : {}),
        ...(settleBalance ? { paidAmount: toDec(settleBalance.total) } : {}),
      },
    });
    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: current.status,
        toStatus: status,
        changedBy: opts.changedBy ?? null,
        note: opts.note?.trim() || null,
      },
    });
    return order;
  });

  socketService.emitToCompany(companyId, SOCKET_EVENTS.ORDER_NEW, {
    id: updated.id,
    orderCode: updated.orderCode,
    status: updated.status,
    customerName: updated.customerName,
  });
  // Aviso al cliente (solo si quien cambia el estado lo pidió y el evento está encendido).
  const event = opts.notify ? noticeEventForStatus(status) : null;
  const notice = event ? await notifyOrderEvent(companyId, orderId, event) : undefined;
  return { ...mapOrder(updated), notice };
}

export interface RegisterPaymentInput {
  amount: number;
  method?: string | null;
  note?: string | null;
  kind?: PaymentKind;
  source?: PaymentSource;
  createdBy?: string | null;
}

/**
 * Registra a mano un pago (adelanto, saldo o total) de un pedido con montos. Lo usan
 * el panel y el Copiloto cuando el pago no pasó por la validación automática.
 */
export async function registerOrderPayment(companyId: string, orderId: string, input: RegisterPaymentInput) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, companyId },
    select: { id: true, status: true, totalAmount: true, advanceAmount: true, paidAmount: true },
  });
  if (!order) throw new AppError("Pedido no encontrado", 404);
  const money = moneyOf(order);
  if (!money) {
    throw new AppError("Este pedido no maneja pagos parciales; cambia su estado a Pagado", 400);
  }
  if (order.status === "CANCELADO") throw new AppError("El pedido está cancelado; reactívalo antes de registrar un pago", 400);
  if (money.balance <= 0.005) throw new AppError("Este pedido ya está pagado por completo", 400);

  const payment = await applyOrderPayment({
    companyId,
    orderId,
    amount: input.amount,
    source: input.source ?? "PANEL",
    kind: input.kind,
    method: input.method,
    note: input.note,
    createdBy: input.createdBy,
  });
  if (!payment) throw new AppError("No se pudo registrar el pago", 400);
  // Pago fuera del chat: la conversación queda lista para seguir y el cliente recibe el aviso.
  const notice = payment.already ? undefined : await afterOrderPaymentOutsideChat(companyId, orderId, { fullyPaid: payment.fullyPaid });
  return { payment, order: await getOrderDetail(companyId, orderId), ...(notice ? { notice } : {}) };
}

export interface UpdateShippingInput {
  deliveryType?: string | null;
  courier?: string | null;
  /** Agencia del catálogo: se guarda su foto (nombre y dirección) en el pedido. */
  agencyId?: string | null;
  /** Agencia escrita a mano (courier sin catálogo). */
  agencyText?: string | null;
  agencyAddress?: string | null;
  recipientDocument?: string | null;
  recipientPhone?: string | null;
  trackingCode?: string | null;
  pickupKey?: string | null;
  shippingAmount?: number;
  address?: string;
  reference?: string;
}

const clean = (v: string | null | undefined) => v?.trim() || null;

/**
 * Edita los datos de envío de un pedido: tipo de entrega, agencia, quién recoge, guía,
 * clave y costo de envío. Cambiar el costo recalcula el total y el estado de pago; en
 * pedidos sin montos solo se guardan los datos (el costo no se puede tocar).
 */
export async function updateOrderShipping(companyId: string, orderId: string, input: UpdateShippingInput) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, companyId },
    select: { id: true, orderCode: true, status: true, subtotalAmount: true, totalAmount: true, advanceAmount: true, paidAmount: true },
  });
  if (!order) throw new AppError("Pedido no encontrado", 404);

  const data: Prisma.OrderUpdateInput = {};
  if (input.deliveryType !== undefined) {
    const type = input.deliveryType ? parseDeliveryType(input.deliveryType) : null;
    if (input.deliveryType && !type) throw new AppError("Tipo de entrega inválido; usa DOMICILIO, AGENCIA o RECOJO", 400);
    data.deliveryType = type;
  }
  if (input.agencyId) {
    const agency = await findAgencyById(input.agencyId);
    if (!agency) throw new AppError("Agencia no encontrada en el catálogo", 404);
    data.agencyId = agency.id;
    data.agencyName = agency.displayName;
    data.agencyAddress = agency.address || null;
    data.courier = agency.courier;
  } else if (input.agencyText !== undefined || input.agencyId === null) {
    data.agencyId = null;
    data.agencyName = clean(input.agencyText);
    data.agencyAddress = clean(input.agencyAddress);
  } else if (input.agencyAddress !== undefined) {
    data.agencyAddress = clean(input.agencyAddress);
  }
  if (input.courier !== undefined && !input.agencyId) data.courier = clean(input.courier)?.toUpperCase() ?? null;
  if (input.recipientDocument !== undefined) data.recipientDocument = clean(input.recipientDocument);
  if (input.recipientPhone !== undefined) data.recipientPhone = clean(input.recipientPhone);
  if (input.trackingCode !== undefined) data.trackingCode = clean(input.trackingCode);
  if (input.pickupKey !== undefined) data.pickupKey = clean(input.pickupKey);
  if (input.address !== undefined && input.address.trim()) data.address = input.address.trim();
  if (input.reference !== undefined) data.reference = input.reference.trim();

  if (input.shippingAmount !== undefined) {
    const money = moneyOf(order);
    if (!money) throw new AppError("Este pedido no maneja montos; el costo de envío no se puede cambiar", 400);
    const shipping = Math.max(0, Number(input.shippingAmount) || 0);
    const subtotal = order.subtotalAmount == null ? money.total : Number(order.subtotalAmount);
    const total = subtotal + shipping;
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { currency: true } });
    data.shippingAmount = toDec(shipping);
    data.totalAmount = toDec(total);
    data.total = `${symbolFor(company?.currency)} ${total.toFixed(2)}`;
    if (money.advance > total) data.advanceAmount = toDec(total);
    data.paymentStatus = money.paid <= 0.005 ? "PENDIENTE_PAGO" : money.paid >= total - 0.005 ? "PAGADO" : "PAGO_PARCIAL";
  }

  if (Object.keys(data).length) {
    await prisma.order.update({ where: { id: orderId }, data });
    socketService.emitToCompany(companyId, SOCKET_EVENTS.ORDER_NEW, {
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
    });
  }
  return getOrderDetail(companyId, orderId);
}

/**
 * Marca un pedido como PAGADO al confirmarse un pago (webhook MP, comprobante,
 * panel). No-op si el pedido no existe o ya estaba pagado — NO rompe el flujo
 * de ventas digitales (que no crean Order).
 */
export async function markOrderPaid(
  companyId: string,
  orderId: string | null | undefined,
  opts: { source?: string } = {},
) {
  if (!orderId) return;
  const order = await prisma.order.findFirst({
    where: { id: orderId, companyId },
    select: { id: true, status: true },
  });
  if (!order || order.status === "PAGADO" || order.status === "ENTREGADO") return;
  await updateOrderStatus(companyId, orderId, "PAGADO", {
    changedBy: "sistema",
    note: `Pago confirmado${opts.source ? ` (${opts.source})` : ""}`,
  }).catch(() => undefined);
}

/** Último pedido pendiente de pago de un cliente (para vincular un pago sin orderId). */
export async function findPendingOrderForCustomer(companyId: string, customerId: string): Promise<string | null> {
  const order = await prisma.order.findFirst({
    where: { companyId, customerId, status: { in: ["PENDIENTE_PAGO", "PEDIDO_REGISTRADO", "EN_COORDINACION"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return order?.id ?? null;
}

async function companyTracksStock(companyId: string): Promise<boolean> {
  const cfg = await prisma.agentConfig.findUnique({ where: { companyId }, select: { trackStock: true } });
  return cfg?.trackStock ?? true;
}
