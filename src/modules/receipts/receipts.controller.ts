import { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { sendDigitalDeliveryEmail, EmailDeliveryError } from "../agent/email-delivery";
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

export async function deliverReceiptController(req: Request, res: Response) {
  const receipt = await deliverReceiptManually(req.user!.companyId, String(req.params.id), {
    productId: req.body.productId,
    payerPhone: req.body?.payerPhone ?? undefined,
    conversationId: req.body?.conversationId ?? undefined,
  });
  return res.json(receipt);
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
