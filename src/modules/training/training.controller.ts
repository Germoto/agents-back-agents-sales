import type { Request, Response } from "express";
import { listActiveResources } from "./training-admin.service";

export async function listActiveTrainingResourcesController(_req: Request, res: Response) {
  return res.json(await listActiveResources());
}
