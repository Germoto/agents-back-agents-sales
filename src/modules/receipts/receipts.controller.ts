import { Request, Response } from "express";
import { approveReceipt, deleteReceipt, ignoreReceipt, listReceipts, rejectReceipt } from "./receipts.service";

export async function listReceiptsController(req: Request, res: Response) {
  const receipts = await listReceipts(req.user!.companyId, {
    status: req.query.status ? String(req.query.status) : null,
    from: req.query.from ? String(req.query.from) : null,
    to: req.query.to ? String(req.query.to) : null,
  });
  return res.json(receipts);
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
