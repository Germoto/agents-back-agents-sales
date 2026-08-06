import { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

const ORDER_INCLUDE = {
  customer: true,
  product: { select: { id: true, slug: true, name: true } },
  items: { orderBy: { createdAt: "asc" as const } },
  statusHistory: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.OrderInclude;

export async function listOrders(companyId: string) {
  return prisma.order.findMany({
    where: { companyId },
    include: ORDER_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
}

export async function getOrderDetail(companyId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, companyId },
    include: ORDER_INCLUDE,
  });
  if (!order) throw new AppError("Pedido no encontrado", 404);
  // Comprobante de pago vinculado (por el campo suelto orderId del receipt).
  const receipt = await prisma.paymentReceipt.findFirst({
    where: { companyId, orderId },
    select: { id: true, status: true, amountPaid: true, paymentSource: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return { ...order, receipt };
}

/** Estados que representan que el pedido ya se pagó/salió/entregó (descuentan stock). */
const FULFILLED_STATUSES: OrderStatus[] = ["DESPACHADO", "ENTREGADO", "PAGADO"];

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
  opts: { changedBy?: string | null; note?: string | null } = {},
) {
  const current = await prisma.order.findFirst({
    where: { id: orderId, companyId },
    include: { items: { select: { productId: true, quantity: true } } },
  });
  if (!current) throw new AppError("Pedido no encontrado", 404);
  if (current.status === status) return current;

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
    const order = await tx.order.update({
      where: { id: orderId },
      data: {
        status,
        ...(status === "PAGADO" ? { paymentStatus: "PAGADO" } : {}),
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
  return updated;
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
