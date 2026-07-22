import type { Request, Response } from "express";
import {
  createClient,
  deleteClient,
  getAuthenticatedSuperadmin,
  impersonateClientAdmin,
  listClients,
  loginSuperadmin,
  updateClient,
  updateClientStatus,
} from "./admin-console.service";
import {
  LANDING_SCENES,
  VERTICALS,
  getEnabledVerticals,
  getLandingScene,
  setEnabledVerticals,
  setLandingScene,
} from "../platform-config/platform-config.service";
import {
  ensureSalesAgentTenant,
  getSalesAgentAdmin,
  updateSalesAgentAdmin,
} from "./sales-agent.service";

export async function superadminLoginController(req: Request, res: Response) {
  const result = await loginSuperadmin(req.body.identifier ?? req.body.phone, req.body.password);
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

export async function updateClientController(req: Request, res: Response) {
  const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const client = await updateClient(companyId, req.body);
  return res.json(client);
}

export async function updateClientStatusController(req: Request, res: Response) {
  const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const client = await updateClientStatus(companyId, req.body.isActive);
  return res.json(client);
}

export async function deleteClientController(req: Request, res: Response) {
  const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  console.log("[deleteClientController] DELETE /clients/:id", { companyId });
  try {
    await deleteClient(companyId);
    return res.status(204).send();
  } catch (err) {
    console.error("[deleteClientController] error", err);
    throw err;
  }
}

export async function impersonateClientController(req: Request, res: Response) {
  const companyId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const superadminId = req.user!.id;
  const result = await impersonateClientAdmin(superadminId, companyId);
  return res.json(result);
}

export async function getVerticalsController(_req: Request, res: Response) {
  const enabled = await getEnabledVerticals();
  return res.json({ all: VERTICALS, enabled });
}

export async function updateVerticalsController(req: Request, res: Response) {
  const enabled = await setEnabledVerticals(req.body.enabledVerticals);
  return res.json({ all: VERTICALS, enabled });
}

export async function getLandingSceneController(_req: Request, res: Response) {
  const scene = await getLandingScene();
  return res.json({ all: LANDING_SCENES, scene });
}

export async function updateLandingSceneController(req: Request, res: Response) {
  const scene = await setLandingScene(req.body.scene);
  return res.json({ all: LANDING_SCENES, scene });
}

// ---------------------------------------------------------------------------
// Agente de ventas de la plataforma (chat del landing que capta tenants)
// ---------------------------------------------------------------------------

export async function getSalesAgentController(req: Request, res: Response) {
  const result = await getSalesAgentAdmin({ id: req.user!.id, phone: req.user!.phone });
  return res.json(result);
}

export async function updateSalesAgentController(req: Request, res: Response) {
  const result = await updateSalesAgentAdmin({ id: req.user!.id, phone: req.user!.phone }, req.body);
  return res.json(result);
}

export async function impersonateSalesAgentController(req: Request, res: Response) {
  const companyId = await ensureSalesAgentTenant({ id: req.user!.id, phone: req.user!.phone });
  const result = await impersonateClientAdmin(req.user!.id, companyId);
  return res.json(result);
}
