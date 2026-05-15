import { Request, Response } from "express";
import { getBusinessProfile, updateBusinessProfile } from "./business.service";

export async function getBusinessProfileController(req: Request, res: Response) {
  const company = await getBusinessProfile(req.user!.companyId);
  return res.json(company);
}

export async function updateBusinessProfileController(req: Request, res: Response) {
  const company = await updateBusinessProfile(req.user!.companyId, req.body);
  return res.json(company);
}
