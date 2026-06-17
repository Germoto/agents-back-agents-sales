import { Request, Response } from "express";
import { getSetupStatus } from "./setup.service";

export async function getSetupStatusController(req: Request, res: Response) {
  const status = await getSetupStatus(req.user!.companyId);
  return res.json(status);
}
