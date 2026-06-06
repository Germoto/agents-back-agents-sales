import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/app-error";

/**
 * Verificación opcional del webhook inbound del agente. Si AGENT_INBOUND_API_KEY
 * está definido, exige el header x-api-key con ese valor (igual patrón que
 * optionalBotApiKey). Si no está definido, deja pasar (útil en desarrollo).
 */
export function optionalAgentApiKey(req: Request, _res: Response, next: NextFunction) {
  if (!env.AGENT_INBOUND_API_KEY) {
    return next();
  }
  // Acepta el secreto por header (x-api-key) o por query (?key=) porque algunos
  // proveedores de webhook solo permiten añadir un query string a la URL.
  const apiKey = req.header("x-api-key") ?? (req.query.key as string | undefined);
  if (apiKey !== env.AGENT_INBOUND_API_KEY) {
    return next(new AppError("x-api-key invalida", 401));
  }
  next();
}
