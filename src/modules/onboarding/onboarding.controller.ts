import type { Request, Response } from "express";
import { getOnboarding, updateOnboarding } from "./onboarding.service";

export async function getOnboardingController(req: Request, res: Response) {
  return res.json(await getOnboarding(req.user!.companyId));
}

export async function updateOnboardingController(req: Request, res: Response) {
  return res.json(await updateOnboarding(req.user!.companyId, req.body ?? {}));
}
