import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { validatePaymentInValidPay } from "../../lib/validpay-client";
import { persistInboundMedia } from "../../lib/inbound-media";
import { env } from "../../config/env";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

export interface ReceiptFilters {
  status?: string | null;
  from?: string | null;
  to?: string | null;
}

export async function listReceipts(companyId: string, filters?: ReceiptFilters) {
  const where: Prisma.PaymentReceiptWhereInput = { companyId };
  if (filters?.status && filters.status !== "ALL") {
    where.status = filters.status as Prisma.PaymentReceiptWhereInput["status"];
  }
  if (filters?.from || filters?.to) {
    where.createdAt = {};
    if (filters.from) (where.createdAt as Prisma.DateTimeFilter).gte = new Date(filters.from);
    if (filters.to) {
      // 'to' inclusivo: hasta el final del día indicado.
      const end = new Date(filters.to);
      end.setHours(23, 59, 59, 999);
      (where.createdAt as Prisma.DateTimeFilter).lte = end;
    }
  }
  return prisma.paymentReceipt.findMany({
    where,
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

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)(\?|$)/i;

function isImageMedia(url: string | null, mediaType: string | null): boolean {
  if (!url) return false;
  if ((mediaType ?? "").toLowerCase() === "image") return true;
  return IMAGE_EXT.test(url);
}

export type ReceiptProof = {
  mediaUrl: string | null;
  mediaType: string | null;
  source: "receipt" | "chat" | null;
};

/**
 * Imagen de la constancia de pago para mostrar en la lupa del panel. Si el
 * comprobante trae imagen propia la usa; si no (p. ej. pagos "ValidPay · auto"
 * confirmados por API), busca la captura que el cliente envió por WhatsApp más
 * cercana al momento del comprobante.
 */
/** ¿La URL ya está en nuestro almacenamiento estático (carga en el navegador)? */
function isLocalUrl(url: string): boolean {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return url.startsWith(`${base}/uploads/`) || url.startsWith("/uploads/");
}

/**
 * Si la URL es externa (SMS Tools, que expira y no carga en <img>), la descarga a
 * /uploads y persiste la URL local en el mensaje para que el chat también la vea.
 * Best-effort: si falla devuelve la URL original.
 */
async function ensureLocalProof(
  companyId: string,
  messageId: string,
  url: string,
): Promise<string> {
  if (isLocalUrl(url)) return url;
  const local = await persistInboundMedia(companyId, url, "image");
  if (!local) return url;
  await prisma.conversationMessage.update({ where: { id: messageId }, data: { mediaUrl: local } }).catch(() => undefined);
  return local;
}

export async function getReceiptProof(companyId: string, receiptId: string): Promise<ReceiptProof> {
  const receipt = await findReceipt(companyId, receiptId);
  if (receipt.mediaUrl) {
    return { mediaUrl: receipt.mediaUrl, mediaType: "image", source: "receipt" };
  }
  if (!receipt.customerId) return { mediaUrl: null, mediaType: null, source: null };

  // Solo mensajes-imagen SIN texto: la captura del pago llega sin caption. Los
  // mensajes con texto que traen una "imagen" son la foto de perfil fantasma.
  const pick = (rows: { id: string; message: string | null; mediaUrl: string | null; mediaType: string | null }[]) =>
    rows.find((m) => (!m.message || !m.message.trim()) && isImageMedia(m.mediaUrl, m.mediaType)) ?? null;

  // 1) Ventana alrededor del momento del comprobante (la captura suele llegar justo antes).
  const windowStart = new Date(receipt.createdAt.getTime() - 6 * 60 * 60 * 1000);
  const windowEnd = new Date(receipt.createdAt.getTime() + 30 * 60 * 1000);
  const near = await prisma.conversationMessage.findMany({
    where: {
      companyId,
      customerId: receipt.customerId,
      role: "USER",
      mediaUrl: { not: null },
      createdAt: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, message: true, mediaUrl: true, mediaType: true },
  });

  // 2) Fallback: la última imagen que envió el cliente (sin ventana de tiempo).
  const hit =
    pick(near) ??
    pick(
      await prisma.conversationMessage.findMany({
        where: { companyId, customerId: receipt.customerId, role: "USER", mediaUrl: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, message: true, mediaUrl: true, mediaType: true },
      }),
    );

  if (!hit?.mediaUrl) return { mediaUrl: null, mediaType: null, source: null };
  const mediaUrl = await ensureLocalProof(companyId, hit.id, hit.mediaUrl);
  return { mediaUrl, mediaType: hit.mediaType ?? "image", source: "chat" };
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
  payerPhone?: string | null,
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

  // Teléfono que hizo el pago: puede no estar en Conversaciones (venta iniciada
  // por chat humano). Se normaliza a solo dígitos.
  const normalizedPhone =
    payerPhone != null ? payerPhone.replace(/\D/g, "") || null : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    const approved = await applyReceiptApproval(tx, receipt.id, receipt.digitalSaleId);
    if (productId || normalizedPhone !== undefined) {
      return tx.paymentReceipt.update({
        where: { id: receipt.id },
        data: {
          ...(productId ? { productId } : {}),
          ...(normalizedPhone !== undefined ? { payerPhone: normalizedPhone } : {}),
        },
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
 * Asocia (o cambia) el producto de un comprobante ya APROBADO, sin tocar el estado.
 * Opcionalmente corrige el teléfono que hizo el pago. No notifica a ValidPay
 * porque el estado no cambia. Reutilizado por el panel para comprobantes "Sin asociar".
 */
export async function associateReceiptProduct(
  companyId: string,
  receiptId: string,
  productId?: string | null,
  payerPhone?: string | null,
) {
  await findReceipt(companyId, receiptId);

  // Solo productos de la empresa (si se asocia uno)
  if (productId) {
    const product = await prisma.product.findFirst({
      where: { id: productId, companyId },
      select: { id: true },
    });
    if (!product) throw new AppError("Producto no encontrado", 404);
  }

  // Teléfono que hizo el pago: se normaliza a solo dígitos. undefined = no tocar.
  const normalizedPhone =
    payerPhone != null ? payerPhone.replace(/\D/g, "") || null : undefined;

  const updated = await prisma.paymentReceipt.update({
    where: { id: receiptId },
    data: {
      productId: productId ?? null,
      ...(normalizedPhone !== undefined ? { payerPhone: normalizedPhone } : {}),
    },
  });

  // Refresco en vivo del panel
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
