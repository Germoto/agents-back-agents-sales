import { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { sendDigitalDeliveryEmail, EmailDeliveryError, type SendDigitalDeliveryEmailResult } from "../agent/email-delivery";
import { recordMessage } from "../agent/conversation.service";
import { maskEmail } from "../../lib/email";
import { approveReceipt, associateReceiptProduct, deleteReceipt, deliverReceiptManually, getReceiptProof, ignoreReceipt, listReceipts, rejectReceipt } from "./receipts.service";

export async function listReceiptsController(req: Request, res: Response) {
  const receipts = await listReceipts(req.user!.companyId, {
    status: req.query.status ? String(req.query.status) : null,
    from: req.query.from ? String(req.query.from) : null,
    to: req.query.to ? String(req.query.to) : null,
    customerId: req.query.customerId ? String(req.query.customerId) : null,
  });
  return res.json(receipts);
}

export async function getReceiptProofController(req: Request, res: Response) {
  const proof = await getReceiptProof(req.user!.companyId, String(req.params.id));
  return res.json(proof);
}

export async function approveReceiptController(req: Request, res: Response) {
  const receipt = await approveReceipt(
    req.user!.companyId,
    String(req.params.id),
    req.body?.productId ?? null,
    req.body?.payerPhone ?? undefined,
  );
  return res.json(receipt);
}

export async function associateReceiptController(req: Request, res: Response) {
  const receipt = await associateReceiptProduct(
    req.user!.companyId,
    String(req.params.id),
    req.body?.productId ?? null,
    req.body?.payerPhone ?? undefined,
  );
  return res.json(receipt);
}

/**
 * Deja en el chat una nota de sistema «📧 Acceso enviado por correo a c***@…»:
 * con la entrega SOLO por correo no hay mensajes de WhatsApp que muestren que se
 * entregó. Best-effort (si falla, el correo ya salió).
 */
async function recordEmailDeliveryNote(
  companyId: string,
  customerId: string,
  conversationId: string | null | undefined,
  result: SendDigitalDeliveryEmailResult,
): Promise<void> {
  try {
    const convoId =
      conversationId ??
      (
        await prisma.conversation.findFirst({
          where: { companyId, customerId },
          orderBy: { lastMessageAt: "desc" },
          select: { id: true },
        })
      )?.id;
    if (!convoId) return;
    const products = result.products.length ? ` (${result.products.join(", ")})` : "";
    await recordMessage({
      companyId,
      customerId,
      conversationId: convoId,
      role: "SYSTEM",
      message: `📧 Acceso enviado por correo a ${maskEmail(result.email)}${products}.`,
      rawPayload: { source: "panel-email-delivery" },
    });
  } catch (err) {
    console.warn("[receipts] nota de entrega por correo falló:", err instanceof Error ? err.message : err);
  }
}

export async function deliverReceiptController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const conversationId: string | null = req.body?.conversationId ?? null;
  const receipt = await deliverReceiptManually(companyId, String(req.params.id), {
    productId: req.body.productId,
    payerPhone: req.body?.payerPhone ?? undefined,
    conversationId: conversationId ?? undefined,
  });
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!email) return res.json(receipt);
  // Entrega también por correo. Un fallo del correo NO deshace la entrega: se
  // devuelve el motivo para que el panel lo muestre.
  const customerId = (receipt as { customerId?: string | null }).customerId ?? null;
  if (!customerId) return res.json({ ...receipt, emailDeliveryError: "El comprobante no está vinculado a un cliente" });
  try {
    const emailDelivery = await sendDigitalDeliveryEmail({ companyId, customerId, receiptId: receipt.id, email, trigger: "panel" });
    await recordEmailDeliveryNote(companyId, customerId, conversationId, emailDelivery);
    return res.json({ ...receipt, emailDelivery });
  } catch (err) {
    const message = err instanceof EmailDeliveryError || err instanceof Error ? err.message : "No se pudo enviar el correo";
    return res.json({ ...receipt, emailDeliveryError: message });
  }
}

/** Entrega del acceso por correo desde el panel (mismo servicio que usa el agente). */
export async function emailDeliveryController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id: String(req.params.id), companyId },
    select: { id: true, customerId: true },
  });
  if (!receipt) throw new AppError("Comprobante no encontrado", 404);
  if (!receipt.customerId) throw new AppError("El comprobante no está vinculado a un cliente", 422);
  try {
    const result = await sendDigitalDeliveryEmail({
      companyId,
      customerId: receipt.customerId,
      receiptId: receipt.id,
      email: String(req.body.email),
      trigger: "panel",
    });
    await recordEmailDeliveryNote(companyId, receipt.customerId, req.body?.conversationId ?? null, result);
    return res.json(result);
  } catch (err) {
    if (err instanceof EmailDeliveryError) {
      const status = err.code === "SEND_FAILED" ? 502 : err.code === "MAIL_DISABLED" ? 503 : 422;
      throw new AppError(err.message, status);
    }
    throw err;
  }
}

export async function rejectReceiptController(req: Request, res: Response) {
  const receipt = await rejectReceipt(req.user!.companyId, String(req.params.id), req.body.rejectionReason);
  return res.json(receipt);
}

export async function ignoreReceiptController(req: Request, res: Response) {
  const receipt = await ignoreReceipt(req.user!.companyId, String(req.params.id));
  return res.json(receipt);
}

export async function deleteReceiptController(req: Request, res: Response) {
  await deleteReceipt(req.user!.companyId, String(req.params.id));
  return res.status(204).send();
}
