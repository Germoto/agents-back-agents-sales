import { Request, Response } from "express";
import { listDigitalSales } from "./digital-sales.service";

export async function listDigitalSalesController(req: Request, res: Response) {
  const sales = await listDigitalSales(req.user!.companyId);
  return res.json(sales);
}
