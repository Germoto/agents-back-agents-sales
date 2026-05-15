import { Request, Response } from "express";
import { listOrders, updateOrderStatus } from "./orders.service";

export async function listOrdersController(req: Request, res: Response) {
  const orders = await listOrders(req.user!.companyId);
  return res.json(orders);
}

export async function updateOrderStatusController(req: Request, res: Response) {
  const order = await updateOrderStatus(req.user!.companyId, String(req.params.id), req.body.status);
  return res.json(order);
}
