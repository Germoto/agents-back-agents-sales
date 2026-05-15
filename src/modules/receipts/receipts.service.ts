import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

export async function listReceipts(companyId: string) {
  return prisma.paymentReceipt.findMany({
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
      digitalSale: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

async function findReceipt(companyId: string, receiptId: string) {
  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id: receiptId, companyId },
  });

  if (!receipt) {
    throw new AppError("Comprobante no encontrado", 404);
  }

  return receipt;
}

export async function approveReceipt(companyId: string, receiptId: string) {
  const receipt = await findReceipt(companyId, receiptId);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.paymentReceipt.update({
      where: { id: receipt.id },
      data: {
        status: "APROBADO",
        rejectionReason: null,
      },
    });

    if (receipt.digitalSaleId) {
      await tx.digitalSale.update({
        where: { id: receipt.digitalSaleId },
        data: {
          status: "COMPROBANTE_RECIBIDO",
        },
      });
    }

    return updated;
  });
}

export async function rejectReceipt(companyId: string, receiptId: string, rejectionReason: string) {
  const receipt = await findReceipt(companyId, receiptId);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.paymentReceipt.update({
      where: { id: receipt.id },
      data: {
        status: "RECHAZADO",
        rejectionReason,
      },
    });

    if (receipt.digitalSaleId) {
      await tx.digitalSale.update({
        where: { id: receipt.digitalSaleId },
        data: {
          status: "PAGO_RECHAZADO",
        },
      });
    }

    return updated;
  });
}
