import { Request, Response } from "express";
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
  sendQuickReply,
} from "./quick-replies.service";

// --- Categorías ---

export async function listCategoriesController(req: Request, res: Response) {
  return res.json(await listCategories(req.user!.companyId));
}

export async function createCategoryController(req: Request, res: Response) {
  return res.status(201).json(await createCategory(req.user!.companyId, req.body.name));
}

export async function updateCategoryController(req: Request, res: Response) {
  return res.json(await updateCategory(req.user!.companyId, String(req.params.id), req.body.name));
}

export async function deleteCategoryController(req: Request, res: Response) {
  await deleteCategory(req.user!.companyId, String(req.params.id));
  return res.json({ success: true });
}

// --- Respuestas rápidas ---

export async function listQuickRepliesController(req: Request, res: Response) {
  return res.json(await listQuickReplies(req.user!.companyId));
}

export async function createQuickReplyController(req: Request, res: Response) {
  return res.status(201).json(await createQuickReply(req.user!.companyId, req.body));
}

export async function updateQuickReplyController(req: Request, res: Response) {
  return res.json(await updateQuickReply(req.user!.companyId, String(req.params.id), req.body));
}

export async function deleteQuickReplyController(req: Request, res: Response) {
  await deleteQuickReply(req.user!.companyId, String(req.params.id));
  return res.json({ success: true });
}

export async function sendQuickReplyController(req: Request, res: Response) {
  const result = await sendQuickReply(
    req.user!.companyId,
    String(req.params.id),
    req.body.conversationId,
  );
  return res.json({ success: true, ...result });
}
