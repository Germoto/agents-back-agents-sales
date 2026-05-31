import { Request, Response } from "express";
import { approveReceipt, deleteReceipt, listReceipts, rejectReceipt } from "./receipts.service";

export async function listReceiptsController(req: Request, res: Response) {
  const receipts = await listReceipts(req.user!.companyId);
  return res.json(receipts);
}

export async function approveReceiptController(req: Request, res: Response) {
  const receipt = await approveReceipt(req.user!.companyId, String(req.params.id));
  return res.json(receipt);
}

export async function rejectReceiptController(req: Request, res: Response) {
  const receipt = await rejectReceipt(req.user!.companyId, String(req.params.id), req.body.rejectionReason);
  return res.json(receipt);
}

export async function deleteReceiptController(req: Request, res: Response) {
  await deleteReceipt(req.user!.companyId, String(req.params.id));
  return res.status(204).send();
}
