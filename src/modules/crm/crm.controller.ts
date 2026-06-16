import { Request, Response } from "express";
import {
  listCrms,
  createCrm,
  updateCrm,
  deleteCrm,
  getBoard,
  createColumn,
  updateColumn,
  deleteColumn,
  reorderColumns,
  moveCard,
  listTags,
  createTag,
  updateTag,
  deleteTag,
  setCustomerTags,
  listDeals,
  createDeal,
  updateDeal,
  deleteDeal,
  getFunnelMetrics,
  type FunnelMode,
} from "./crm.service";

// --- CRMs ---

export async function listCrmsController(req: Request, res: Response) {
  return res.json(await listCrms(req.user!.companyId));
}

export async function createCrmController(req: Request, res: Response) {
  return res.status(201).json(await createCrm(req.user!.companyId, req.body));
}

export async function updateCrmController(req: Request, res: Response) {
  return res.json(await updateCrm(req.user!.companyId, String(req.params.id), req.body));
}

export async function deleteCrmController(req: Request, res: Response) {
  await deleteCrm(req.user!.companyId, String(req.params.id));
  return res.json({ success: true });
}

// --- Board / columnas / move ---

export async function getBoardController(req: Request, res: Response) {
  return res.json(await getBoard(req.user!.companyId, String(req.params.id)));
}

export async function createColumnController(req: Request, res: Response) {
  return res
    .status(201)
    .json(await createColumn(req.user!.companyId, String(req.params.id), req.body));
}

export async function updateColumnController(req: Request, res: Response) {
  return res.json(
    await updateColumn(
      req.user!.companyId,
      String(req.params.id),
      String(req.params.columnId),
      req.body,
    ),
  );
}

export async function deleteColumnController(req: Request, res: Response) {
  await deleteColumn(req.user!.companyId, String(req.params.id), String(req.params.columnId));
  return res.json({ success: true });
}

export async function reorderColumnsController(req: Request, res: Response) {
  await reorderColumns(req.user!.companyId, String(req.params.id), req.body.columnIds);
  return res.json({ success: true });
}

export async function moveCardController(req: Request, res: Response) {
  await moveCard(req.user!.companyId, String(req.params.id), req.body);
  return res.json({ success: true });
}

// --- Etiquetas ---

export async function listTagsController(req: Request, res: Response) {
  return res.json(await listTags(req.user!.companyId));
}

export async function createTagController(req: Request, res: Response) {
  return res.status(201).json(await createTag(req.user!.companyId, req.body));
}

export async function updateTagController(req: Request, res: Response) {
  return res.json(await updateTag(req.user!.companyId, String(req.params.tagId), req.body));
}

export async function deleteTagController(req: Request, res: Response) {
  await deleteTag(req.user!.companyId, String(req.params.tagId));
  return res.json({ success: true });
}

export async function setCustomerTagsController(req: Request, res: Response) {
  await setCustomerTags(req.user!.companyId, String(req.params.customerId), req.body.tagIds);
  return res.json({ success: true });
}

// --- Valores de negocio ---

export async function listDealsController(req: Request, res: Response) {
  return res.json(await listDeals(req.user!.companyId, String(req.params.customerId)));
}

export async function createDealController(req: Request, res: Response) {
  return res
    .status(201)
    .json(await createDeal(req.user!.companyId, String(req.params.customerId), req.body));
}

export async function updateDealController(req: Request, res: Response) {
  return res.json(await updateDeal(req.user!.companyId, String(req.params.dealId), req.body));
}

export async function deleteDealController(req: Request, res: Response) {
  await deleteDeal(req.user!.companyId, String(req.params.dealId));
  return res.json({ success: true });
}

// --- Embudo de ventas ---

export async function funnelController(req: Request, res: Response) {
  const rawMode = String(req.query.mode ?? "crm");
  const mode: FunnelMode = rawMode === "columns" || rawMode === "tags" ? rawMode : "crm";
  const crmId = req.query.crmId ? String(req.query.crmId) : null;
  return res.json(await getFunnelMetrics(req.user!.companyId, mode, crmId));
}
