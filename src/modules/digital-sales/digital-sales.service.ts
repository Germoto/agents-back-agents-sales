import { prisma } from "../../lib/prisma";

export async function listDigitalSales(companyId: string) {
  return prisma.digitalSale.findMany({
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
      receipts: true,
    },
    orderBy: { createdAt: "desc" },
  });
}
