/**
 * Registro de pedidos físicos desde el agente (Fase 2). Crea un `Order` con un
 * orderCode único, lo asocia al cliente/producto y emite un evento de tiempo
 * real al panel. El admin gestiona el estado del pedido desde la página Pedidos.
 */

import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

// Código corto y legible: PED-<base36 del tiempo>-<aleatorio>. Se pasa el
// timestamp desde el caller (Date.now en backend es válido) para mantenerlo puro.
function buildOrderCode(seed: number): string {
  const t = seed.toString(36).toUpperCase().slice(-6);
  const r = Math.floor((seed % 1000) + (seed % 97)).toString(36).toUpperCase().slice(-2);
  return `PED-${t}${r}`;
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
}

export async function createAgentOrder(input: CreateOrderInput) {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, companyId: input.companyId, active: true },
    select: { id: true, name: true, productType: true },
  });
  if (!product) throw new AppError("Producto no encontrado o inactivo", 404);
  if (product.productType !== "PHYSICAL") {
    throw new AppError("Solo se registran pedidos para productos físicos", 422);
  }

  const order = await prisma.order.create({
    data: {
      companyId: input.companyId,
      customerId: input.customerId,
      productId: input.productId,
      orderCode: buildOrderCode(Date.now()),
      quantity: Math.max(1, input.quantity || 1),
      customerName: input.customerName.trim(),
      address: input.address.trim(),
      reference: (input.reference ?? "").trim(),
      notes: input.notes?.trim() || null,
      status: "PEDIDO_REGISTRADO",
    },
    include: { product: { select: { name: true } } },
  });

  socketService.emitToCompany(input.companyId, SOCKET_EVENTS.ORDER_NEW, {
    id: order.id,
    orderCode: order.orderCode,
    status: order.status,
    customerName: order.customerName,
    product: order.product?.name,
  });

  return order;
}
