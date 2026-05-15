import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

type OrderStatus = "PEDIDO_REGISTRADO" | "EN_COORDINACION" | "DESPACHADO" | "CANCELADO";

export async function listOrders(companyId: string) {
  return prisma.order.findMany({
    where: { companyId },
    include: {
      customer: true,
      product: {
        select: {
          id: true,
          slug: true,
          name: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateOrderStatus(companyId: string, orderId: string, status: OrderStatus) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, companyId },
  });

  if (!order) {
    throw new AppError("Pedido no encontrado", 404);
  }

  return prisma.order.update({
    where: { id: orderId },
    data: { status },
  });
}
