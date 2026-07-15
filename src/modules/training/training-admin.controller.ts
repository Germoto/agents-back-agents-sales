import type { Request, Response } from "express";
import { createResource, deleteResource, listResources, updateResource } from "./training-admin.service";

const paramId = (req: Request, key = "id") => {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
};

export async function listTrainingResourcesController(_req: Request, res: Response) {
  return res.json(await listResources());
}

export async function createTrainingResourceController(req: Request, res: Response) {
  return res.status(201).json(await createResource(req.body));
}

export async function updateTrainingResourceController(req: Request, res: Response) {
  return res.json(await updateResource(paramId(req), req.body));
}

export async function deleteTrainingResourceController(req: Request, res: Response) {
  await deleteResource(paramId(req));
  return res.status(204).send();
}
