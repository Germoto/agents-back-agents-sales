import { Request, Response } from "express";
import { listCustomers } from "./customers.service";

export async function listCustomersController(req: Request, res: Response) {
  const customers = await listCustomers(req.user!.companyId);
  return res.json(customers);
}
