import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { validatePaymentInValidPay } from "../../lib/validpay-client";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

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

/**
 * Helper reutilizable: aprueba un comprobante y, si tiene DigitalSale asociada,
 * actualiza su estado a COMPROBANTE_RECIBIDO — todo en una misma transacción.
 * Puede recibir un PrismaClient o una transacción Prisma existente.
 */
export async function applyReceiptApproval(
  tx: Prisma.TransactionClient,
  receiptId: string,
  digitalSaleId: string | null,
) {
  const updated = await tx.paymentReceipt.update({
    where: { id: receiptId },
    data: {
      status: "APROBADO",
      rejectionReason: null,
    },
  });

  if (digitalSaleId) {
    await tx.digitalSale.update({
      where: { id: digitalSaleId },
      data: { status: "COMPROBANTE_RECIBIDO" },
    });
  }

  return updated;
}

export async function approveReceipt(
  companyId: string,
  receiptId: string,
  productId?: string | null,
) {
  const receipt = await findReceipt(companyId, receiptId);

  // Asociar a un producto al aprobar (opcional, solo productos de la empresa)
  if (productId) {
    const product = await prisma.product.findFirst({
      where: { id: productId, companyId },
      select: { id: true },
    });
    if (!product) throw new AppError("Producto no encontrado", 404);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const approved = await applyReceiptApproval(tx, receipt.id, receipt.digitalSaleId);
    if (productId) {
      return tx.paymentReceipt.update({
        where: { id: receipt.id },
        data: { productId },
      });
    }
    return approved;
  });

  // Notificar a ValidPay de forma asíncrona (best-effort) si el receipt viene de ValidPay
  // y el endpoint tiene una API Key configurada.
  if (receipt.source === "validpay" && receipt.externalId) {
    notifyValidPayApproval(companyId, receipt.externalId).catch((err) => {
      console.error("[ValidPay] No se pudo notificar aprobación:", err.message);
    });
  }

  // Emitir evento Socket.IO para que el frontend actualice en tiempo real
  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_UPDATED, {
    id: updated.id,
    status: updated.status,
    source: updated.source,
    externalId: updated.externalId,
  });

  return updated;
}

/**
 * Busca la API Key de ValidPay del endpoint activo de la empresa
 * y llama a ValidPay para marcar el pago como validado.
 */
async function notifyValidPayApproval(companyId: string, externalId: string): Promise<void> {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { companyId, source: "validpay", active: true, validpayApiKey: { not: null } },
    select: { validpayApiKey: true },
  });

  if (!endpoint?.validpayApiKey) return; // Sin API Key configurada, silencio

  await validatePaymentInValidPay(endpoint.validpayApiKey, externalId);
}

/**
 * Marca un comprobante como IGNORADO ("otros"): es un pago real pero ajeno a
 * una venta. NO notifica a ValidPay ni toca la venta digital asociada.
 */
export async function ignoreReceipt(companyId: string, receiptId: string) {
  const receipt = await findReceipt(companyId, receiptId);

  const updated = await prisma.paymentReceipt.update({
    where: { id: receipt.id },
    data: { status: "IGNORADO", rejectionReason: null },
  });

  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_UPDATED, {
    id: updated.id,
    status: updated.status,
    source: updated.source,
    externalId: updated.externalId,
  });

  return updated;
}

export async function deleteReceipt(companyId: string, receiptId: string) {
  await findReceipt(companyId, receiptId);
  await prisma.paymentReceipt.delete({ where: { id: receiptId } });
}

export async function rejectReceipt(companyId: string, receiptId: string, rejectionReason: string) {
  const receipt = await findReceipt(companyId, receiptId);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.paymentReceipt.update({
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

    return result;
  });

  // Emitir evento Socket.IO para que el frontend actualice en tiempo real
  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_UPDATED, {
    id: updated.id,
    status: updated.status,
    source: updated.source,
    externalId: updated.externalId,
  });

  return updated;
}
