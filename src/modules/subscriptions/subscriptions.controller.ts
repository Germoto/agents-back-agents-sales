import { Request, Response } from "express";
import {
  createSubscription,
  listSubscriptions,
  markRenewed,
  markCancelled,
  deleteSubscription,
} from "./subscriptions.service";
import {
  createSubscriptionSchema,
  listSubscriptionsQuerySchema,
  subscriptionIdParamsSchema,
  markRenewedSchema,
} from "./subscriptions.schemas";

export async function listSubscriptionsController(req: Request, res: Response) {
  const opts = listSubscriptionsQuerySchema.parse(req.query);
  const items = await listSubscriptions(req.user!.companyId, opts);
  return res.json(items);
}

export async function createSubscriptionController(req: Request, res: Response) {
  const data = createSubscriptionSchema.parse(req.body);
  const sub = await createSubscription(req.user!.companyId, data);
  return res.status(201).json(sub);
}

export async function renewSubscriptionController(req: Request, res: Response) {
  const { id } = subscriptionIdParamsSchema.parse(req.params);
  const body = markRenewedSchema.parse(req.body);
  const sub = await markRenewed(req.user!.companyId, id, body?.reminder);
  return res.json(sub);
}

export async function cancelSubscriptionController(req: Request, res: Response) {
  const { id } = subscriptionIdParamsSchema.parse(req.params);
  const sub = await markCancelled(req.user!.companyId, id);
  return res.json(sub);
}

export async function deleteSubscriptionController(req: Request, res: Response) {
  const { id } = subscriptionIdParamsSchema.parse(req.params);
  const result = await deleteSubscription(req.user!.companyId, id);
  return res.json(result);
}
