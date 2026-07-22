import { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/app-error";
import { verifyWebchatToken, type WebchatJwtPayload } from "../../lib/jwt";

/** Request con la sesión del visitante del chat web ya verificada. */
export interface WebchatRequest extends Request {
  webchat?: WebchatJwtPayload;
}

/**
 * Autentica al visitante del widget por su sessionToken (JWT kind "webchat")
 * en `Authorization: Bearer …`. No es un User del panel: solo da acceso a SU
 * conversación (companyId/conversationId/customerId vienen del token).
 */
export function requireWebchatSession(req: WebchatRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return next(new AppError("Sesión requerida", 401));
  try {
    req.webchat = verifyWebchatToken(token);
  } catch {
    return next(new AppError("Sesión inválida o expirada", 401));
  }
  next();
}
