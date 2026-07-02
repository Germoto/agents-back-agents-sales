import { Request, Response } from "express";
import {
  createWhatsappLink,
  deleteWhatsappAccount,
  deleteWhatsappReceived,
  deleteWhatsappSent,
  getWhatsappConfig,
  getWhatsappLinkInfo,
  getWhatsappQrImage,
  listWhatsappAccounts,
  listWhatsappPending,
  listWhatsappReceived,
  listWhatsappSent,
  listWhatsappServers,
  relinkWhatsappAccount,
  syncWhatsappAccount,
  testWhatsappConnection,
  upsertWhatsappConfig,
  setActiveProvider,
  updateMetaConfig,
  getMetaStatus,
  listMetaTemplates,
} from "./whatsapp-config.service";

export async function getWhatsappConfigController(req: Request, res: Response) {
  const config = await getWhatsappConfig(req.user!.companyId);
  return res.json(config);
}

export async function upsertWhatsappConfigController(req: Request, res: Response) {
  const config = await upsertWhatsappConfig(req.user!.companyId, req.body, req.user!.phone);
  return res.json(config);
}

export async function setProviderController(req: Request, res: Response) {
  const config = await setActiveProvider(req.user!.companyId, req.body.provider);
  return res.json(config);
}

export async function testWhatsappConnectionController(req: Request, res: Response) {
  const result = await testWhatsappConnection(req.body);
  return res.json(result);
}

export async function updateMetaConfigController(req: Request, res: Response) {
  const result = await updateMetaConfig(req.user!.companyId, req.body);
  return res.json(result);
}

export async function getMetaStatusController(req: Request, res: Response) {
  const result = await getMetaStatus(req.user!.companyId);
  return res.json(result);
}

export async function listMetaTemplatesController(req: Request, res: Response) {
  const result = await listMetaTemplates(req.user!.companyId);
  return res.json(result);
}

export async function listWhatsappServersController(req: Request, res: Response) {
  const data = await listWhatsappServers(req.user!.companyId);
  return res.json(data);
}

export async function listWhatsappAccountsController(req: Request, res: Response) {
  const { page, limit } = req.query as { page?: number; limit?: number };
  const data = await listWhatsappAccounts(req.user!.companyId, page, limit);
  return res.json(data);
}

export async function createWhatsappLinkController(req: Request, res: Response) {
  const { sid } = (req.body ?? {}) as { sid?: number };
  const data = await createWhatsappLink(req.user!.companyId, sid);
  return res.json(data);
}

export async function relinkWhatsappAccountController(req: Request, res: Response) {
  const { unique, sid } = req.body as { unique: string; sid?: number };
  const data = await relinkWhatsappAccount(req.user!.companyId, unique, sid);
  return res.json(data);
}

export async function deleteWhatsappAccountController(req: Request, res: Response) {
  const unique = String(req.params.unique);
  const data = await deleteWhatsappAccount(req.user!.companyId, unique);
  return res.json(data);
}

export async function syncWhatsappAccountController(req: Request, res: Response) {
  const data = await syncWhatsappAccount(req.user!.companyId, req.user!.phone);
  return res.json(data);
}

export async function getWhatsappQrImageController(req: Request, res: Response) {
  const { token } = req.query as { token: string };
  const { buffer, contentType } = await getWhatsappQrImage(req.user!.companyId, token);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  return res.send(buffer);
}

export async function getWhatsappLinkInfoController(req: Request, res: Response) {
  const { token } = req.query as { token: string };
  const data = await getWhatsappLinkInfo(req.user!.companyId, token);
  return res.json(data);
}

export async function listWhatsappPendingController(req: Request, res: Response) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  const result = await listWhatsappPending(req.user!.companyId, page, limit);
  return res.json(result);
}

export async function listWhatsappSentController(req: Request, res: Response) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  const result = await listWhatsappSent(req.user!.companyId, page, limit);
  return res.json(result);
}

export async function listWhatsappReceivedController(req: Request, res: Response) {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  const result = await listWhatsappReceived(req.user!.companyId, page, limit);
  return res.json(result);
}

export async function deleteWhatsappSentController(req: Request, res: Response) {
  const id = String(req.params.id);
  const data = await deleteWhatsappSent(req.user!.companyId, id);
  return res.json(data);
}

export async function deleteWhatsappReceivedController(req: Request, res: Response) {
  const id = String(req.params.id);
  const data = await deleteWhatsappReceived(req.user!.companyId, id);
  return res.json(data);
}
