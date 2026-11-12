import { Request, Response } from "express";
import { OrderStatus } from "@prisma/client";
import { getOrderDetail, listOrders, registerOrderPayment, updateOrderShipping, updateOrderStatus } from "./orders.service";

export async function listOrdersController(req: Request, res: Response) {
  const orders = await listOrders(req.user!.companyId);
  return res.json(orders);
}

export async function getOrderDetailController(req: Request, res: Response) {
  const order = await getOrderDetail(req.user!.companyId, String(req.params.id));
  return res.json(order);
}

export async function updateOrderStatusController(req: Request, res: Response) {
  const order = await updateOrderStatus(
    req.user!.companyId,
    String(req.params.id),
    req.body.status as OrderStatus,
    { changedBy: req.user!.id, note: req.body.note, notify: req.body.notify === true },
  );
  return res.json(order);
}

export async function registerOrderPaymentController(req: Request, res: Response) {
  const result = await registerOrderPayment(req.user!.companyId, String(req.params.id), {
    ...req.body,
    source: "PANEL",
    createdBy: req.user!.id,
  });
  return res.status(201).json(result);
}

export async function updateOrderShippingController(req: Request, res: Response) {
  const order = await updateOrderShipping(req.user!.companyId, String(req.params.id), req.body);
  return res.json(order);
}
