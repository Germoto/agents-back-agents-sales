import { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/app-error";
import { simulateTurn, getSimMessages, resetSim, type SimMode } from "./agent-simulate.service";

/** Modo del simulador: "AI" (agente IA) o "FLOW" (flujos). Cada uno tiene su propia conversación. */
function parseMode(value: unknown): SimMode | undefined {
  const v = String(value ?? "").toUpperCase();
  return v === "AI" || v === "FLOW" ? (v as SimMode) : undefined;
}

export const simulateMessagesController = asyncHandler(async (req: Request, res: Response) => {
  const data = await getSimMessages(req.user!.companyId, parseMode(req.query.mode));
  res.json({ success: true, data });
});

export const simulateTurnController = asyncHandler(async (req: Request, res: Response) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) throw new AppError("El mensaje no puede estar vacío", 400);
  const result = await simulateTurn(req.user!.companyId, message, parseMode(req.body?.mode));
  res.json({ success: true, data: result });
});

export const simulateResetController = asyncHandler(async (req: Request, res: Response) => {
  await resetSim(req.user!.companyId, parseMode(req.body?.mode));
  res.json({ success: true });
});
