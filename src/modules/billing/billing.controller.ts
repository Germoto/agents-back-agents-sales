import type { Request, Response } from "express";
import {
  getBillingMe,
  listMyCreditTransactions,
  listPublicPlans,
  redeemVoucher,
} from "./billing.service";

export async function billingMeController(req: Request, res: Response) {
  const data = await getBillingMe(req.user!.companyId);
  return res.json(data);
}

export async function myCreditTransactionsController(req: Request, res: Response) {
  const rows = await listMyCreditTransactions(req.user!.companyId);
  return res.json(rows);
}

export async function redeemVoucherController(req: Request, res: Response) {
  const result = await redeemVoucher(req.user!.companyId, req.user!.id, req.body.code);
  return res.json(result);
}

export async function publicPlansController(_req: Request, res: Response) {
  const plans = await listPublicPlans();
  return res.json(plans);
}
