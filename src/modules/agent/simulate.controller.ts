import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import { simulateTurn, getSimMessages, resetSim } from "./agent-simulate.service";

export const simulateMessagesController = asyncHandler(async (req: Request, res: Response) => {
  const data = await getSimMessages(req.user!.companyId);
  res.json({ success: true, data });
});

export const simulateTurnController = asyncHandler(async (req: Request, res: Response) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) throw new AppError("El mensaje no puede estar vacío", 400);
  const result = await simulateTurn(req.user!.companyId, message);
  res.json({ success: true, data: result });
});

export const simulateResetController = asyncHandler(async (req: Request, res: Response) => {
  await resetSim(req.user!.companyId);
  res.json({ success: true });
});
