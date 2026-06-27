import { Request, Response } from "express";
import {
  listCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  deleteCustomersBulk,
  listNotes,
  createNote,
  deleteNote,
} from "./customers.service";

export async function listCustomersController(req: Request, res: Response) {
  const customers = await listCustomers(req.user!.companyId);
  return res.json(customers);
}

export async function getCustomerController(req: Request, res: Response) {
  return res.json(await getCustomer(req.user!.companyId, String(req.params.id)));
}

export async function updateCustomerController(req: Request, res: Response) {
  return res.json(await updateCustomer(req.user!.companyId, String(req.params.id), req.body));
}

export async function deleteCustomerController(req: Request, res: Response) {
  await deleteCustomer(req.user!.companyId, String(req.params.id));
  return res.json({ success: true });
}

export async function deleteCustomersBulkController(req: Request, res: Response) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x: unknown) => String(x)) : [];
  const result = await deleteCustomersBulk(req.user!.companyId, ids);
  return res.json({ success: true, ...result });
}

export async function listNotesController(req: Request, res: Response) {
  return res.json(await listNotes(req.user!.companyId, String(req.params.id)));
}

export async function createNoteController(req: Request, res: Response) {
  return res.status(201).json(await createNote(req.user!.companyId, String(req.params.id), req.body));
}

export async function deleteNoteController(req: Request, res: Response) {
  await deleteNote(req.user!.companyId, String(req.params.noteId));
  return res.json({ success: true });
}
