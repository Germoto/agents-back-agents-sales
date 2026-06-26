import { Request, Response } from "express";
import {
  listCredentials,
  credentialStats,
  createCredentials,
  updateCredential,
  deleteCredential,
} from "./streaming-inventory.service";
import {
  createCredentialsSchema,
  updateCredentialSchema,
  credentialIdParamsSchema,
  listCredentialsQuerySchema,
} from "./streaming-inventory.schemas";

export async function listCredentialsController(req: Request, res: Response) {
  const { productId } = listCredentialsQuerySchema.parse(req.query);
  const [items, stats] = await Promise.all([
    listCredentials(req.user!.companyId, productId),
    credentialStats(req.user!.companyId),
  ]);
  return res.json({ items, stats });
}

export async function createCredentialsController(req: Request, res: Response) {
  const { productId, items } = createCredentialsSchema.parse(req.body);
  const result = await createCredentials(req.user!.companyId, productId, items);
  return res.status(201).json(result);
}

export async function updateCredentialController(req: Request, res: Response) {
  const { id } = credentialIdParamsSchema.parse(req.params);
  const data = updateCredentialSchema.parse(req.body);
  const updated = await updateCredential(req.user!.companyId, id, data);
  return res.json(updated);
}

export async function deleteCredentialController(req: Request, res: Response) {
  const { id } = credentialIdParamsSchema.parse(req.params);
  const result = await deleteCredential(req.user!.companyId, id);
  return res.json(result);
}
