import { Request, Response } from "express";
import { getReportConfig, updateReportConfig, sendReport } from "./reports.service";

export async function getReportConfigController(req: Request, res: Response) {
  return res.json(await getReportConfig(req.user!.companyId));
}

export async function updateReportConfigController(req: Request, res: Response) {
  return res.json(await updateReportConfig(req.user!.companyId, req.body));
}

/** Envío de prueba inmediato: NO toca lastXKey ni lastError del worker. */
export async function sendTestReportController(req: Request, res: Response) {
  return res.json(await sendReport(req.user!.companyId, req.body.kind));
}
