import type { Request, Response } from "express";
import {
  adjustCredits,
  assignSubscription,
  cancelSubscription,
  createPlan,
  createVoucherBatch,
  deletePlan,
  deleteSubscription,
  deleteVoucher,
  extendSubscription,
  listCompanyCreditTransactions,
  listPlans,
  listSubscriptions,
  listVouchers,
  updatePlan,
} from "./billing-admin.service";

const paramId = (req: Request, key = "id") => {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
};

// ---------------- Paquetes ----------------

export async function listPlansController(_req: Request, res: Response) {
  return res.json(await listPlans());
}

export async function createPlanController(req: Request, res: Response) {
  return res.status(201).json(await createPlan(req.body));
}

export async function updatePlanController(req: Request, res: Response) {
  return res.json(await updatePlan(paramId(req), req.body));
}

export async function deletePlanController(req: Request, res: Response) {
  await deletePlan(paramId(req));
  return res.status(204).send();
}

// ---------------- Suscripciones ----------------

export async function listSubscriptionsController(_req: Request, res: Response) {
  return res.json(await listSubscriptions());
}

export async function assignSubscriptionController(req: Request, res: Response) {
  const { companyId, planId, months } = req.body;
  return res.status(201).json(await assignSubscription(companyId, planId, months));
}

export async function extendSubscriptionController(req: Request, res: Response) {
  return res.json(await extendSubscription(paramId(req), req.body.months));
}

export async function cancelSubscriptionController(req: Request, res: Response) {
  return res.json(await cancelSubscription(paramId(req)));
}

export async function deleteSubscriptionController(req: Request, res: Response) {
  await deleteSubscription(paramId(req));
  return res.status(204).send();
}

// ---------------- Vales ----------------

export async function listVouchersController(req: Request, res: Response) {
  const status = req.query.status as "available" | "redeemed" | undefined;
  return res.json(await listVouchers(status));
}

export async function createVoucherBatchController(req: Request, res: Response) {
  return res.status(201).json(await createVoucherBatch(req.body));
}

export async function deleteVoucherController(req: Request, res: Response) {
  await deleteVoucher(paramId(req));
  return res.status(204).send();
}

// ---------------- Créditos ----------------

export async function adjustCreditsController(req: Request, res: Response) {
  const { companyId, amountPen, note } = req.body;
  return res.json(await adjustCredits(companyId, amountPen, note));
}

export async function companyCreditTransactionsController(req: Request, res: Response) {
  return res.json(await listCompanyCreditTransactions(paramId(req, "companyId")));
}
