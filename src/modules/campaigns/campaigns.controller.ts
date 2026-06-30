import { Request, Response } from "express";
import { AppError } from "../../lib/app-error";
import {
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  listContacts,
  listRecipients,
  pauseCampaign,
  resumeCampaign,
  startCampaign,
  testCampaign,
  updateCampaign,
} from "./campaigns.service";
import { parseSpreadsheet } from "./campaign-import";

export async function listCampaignsController(req: Request, res: Response) {
  const campaigns = await listCampaigns(req.user!.companyId);
  return res.json(campaigns);
}

export async function getCampaignController(req: Request, res: Response) {
  const campaign = await getCampaign(req.user!.companyId, String(req.params.id));
  return res.json(campaign);
}

export async function createCampaignController(req: Request, res: Response) {
  const campaign = await createCampaign(req.user!.companyId, req.body);
  return res.status(201).json(campaign);
}

export async function updateCampaignController(req: Request, res: Response) {
  const campaign = await updateCampaign(req.user!.companyId, String(req.params.id), req.body);
  return res.json(campaign);
}

export async function deleteCampaignController(req: Request, res: Response) {
  const result = await deleteCampaign(req.user!.companyId, String(req.params.id));
  return res.json(result);
}

export async function startCampaignController(req: Request, res: Response) {
  const campaign = await startCampaign(req.user!.companyId, String(req.params.id));
  return res.json(campaign);
}

export async function pauseCampaignController(req: Request, res: Response) {
  const campaign = await pauseCampaign(req.user!.companyId, String(req.params.id));
  return res.json(campaign);
}

export async function resumeCampaignController(req: Request, res: Response) {
  const campaign = await resumeCampaign(req.user!.companyId, String(req.params.id));
  return res.json(campaign);
}

export async function cancelCampaignController(req: Request, res: Response) {
  const campaign = await cancelCampaign(req.user!.companyId, String(req.params.id));
  return res.json(campaign);
}

export async function testCampaignController(req: Request, res: Response) {
  const result = await testCampaign(
    req.user!.companyId,
    String(req.params.id),
    req.body.phone,
    req.body.name,
  );
  return res.json(result);
}

export async function listRecipientsController(req: Request, res: Response) {
  const recipients = await listRecipients(req.user!.companyId, String(req.params.id));
  return res.json(recipients);
}

export async function listContactsController(req: Request, res: Response) {
  const contacts = await listContacts(req.user!.companyId);
  return res.json(contacts);
}

export async function importContactsController(req: Request, res: Response) {
  if (!req.file) throw new AppError("Archivo no recibido", 400);
  const result = parseSpreadsheet(req.file.buffer);
  return res.json(result);
}
