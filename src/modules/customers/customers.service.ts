import { prisma } from "../../lib/prisma";

export async function listCustomers(companyId: string) {
  return prisma.customer.findMany({
    where: { companyId },
    include: {
      selectedProduct: {
        select: {
          id: true,
          slug: true,
          name: true,
        },
      },
    },
    orderBy: { lastInteractionAt: "desc" },
  });
}
