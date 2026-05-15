import type { Request, Response } from "express";
import {
  createClient,
  getAuthenticatedSuperadmin,
  listClients,
  loginSuperadmin,
  updateClientStatus,
} from "./admin-console.service";

export async function superadminLoginController(req: Request, res: Response) {
  const result = await loginSuperadmin(req.body.phone, req.body.password);
  return res.json(result);
}

export async function superadminMeController(req: Request, res: Response) {
  const user = await getAuthenticatedSuperadmin(req.user!.id);
  return res.json(user);
}

export async function listClientsController(_req: Request, res: Response) {
  const clients = await listClients();
  return res.json(clients);
}

export async function createClientController(req: Request, res: Response) {
  const client = await createClient(req.body);
  return res.status(201).json(client);
}

export async function updateClientStatusController(req: Request, res: Response) {
  const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const client = await updateClientStatus(companyId, req.body.isActive);
  return res.json(client);
}
