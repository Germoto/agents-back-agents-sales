import { Request, Response } from "express";
import {
  listFlows,
  getFlow,
  createFlow,
  updateFlow,
  duplicateFlow,
  toggleFlow,
  validateFlowDraft,
  deleteFlow,
} from "./flows.service";

export async function listFlowsController(req: Request, res: Response) {
  return res.json(await listFlows(req.user!.companyId));
}

export async function getFlowController(req: Request, res: Response) {
  return res.json(await getFlow(req.user!.companyId, String(req.params.id)));
}

export async function createFlowController(req: Request, res: Response) {
  return res.status(201).json(await createFlow(req.user!.companyId, req.body));
}

export async function updateFlowController(req: Request, res: Response) {
  return res.json(await updateFlow(req.user!.companyId, String(req.params.id), req.body));
}

export async function duplicateFlowController(req: Request, res: Response) {
  return res.status(201).json(await duplicateFlow(req.user!.companyId, String(req.params.id)));
}

export async function toggleFlowController(req: Request, res: Response) {
  return res.json(await toggleFlow(req.user!.companyId, String(req.params.id), req.body.isActive));
}

export async function validateFlowController(req: Request, res: Response) {
  return res.json(await validateFlowDraft(req.user!.companyId, req.body.nodes, req.body.edges));
}

export async function deleteFlowController(req: Request, res: Response) {
  await deleteFlow(req.user!.companyId, String(req.params.id));
  return res.json({ success: true });
}
