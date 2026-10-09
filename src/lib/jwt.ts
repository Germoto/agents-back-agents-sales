import jwt from "jsonwebtoken";
import { env } from "../config/env";

export type JwtPayload = {
  sub: string;
  companyId: string;
  role: string;
  impersonatedBy?: string;
};

export function signAccessToken(payload: JwtPayload, options?: jwt.SignOptions) {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
    ...options,
  });
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

// ---------------------------------------------------------------------------
// Tokens de sesión del chat web embebible (visitantes anónimos del widget).
// Mismo secreto que el panel pero con `kind: "webchat"` para que NUNCA se
// crucen: un sessionToken de visitante no pasa requireAuth (no trae `sub` de
// User) y un JWT del panel no pasa verifyWebchatToken (no trae `kind`).
// ---------------------------------------------------------------------------

export type WebchatJwtPayload = {
  kind: "webchat";
  companyId: string;
  conversationId: string;
  customerId: string;
};

export function signWebchatToken(payload: Omit<WebchatJwtPayload, "kind">) {
  return jwt.sign({ kind: "webchat", ...payload }, env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyWebchatToken(token: string): WebchatJwtPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as WebchatJwtPayload;
  if (payload?.kind !== "webchat") throw new Error("Token de webchat inválido");
  return payload;
}

// ---------------------------------------------------------------------------
// Enlaces firmados de descarga (archivos privados de entrega). `kind: "download"`
// para no cruzarse con los tokens del panel ni del chat web. Vigencia 7 días.
// ---------------------------------------------------------------------------

export type DownloadJwtPayload = { kind: "download"; companyId: string; fileId: string; ref?: string };

export function signDownloadToken(payload: Omit<DownloadJwtPayload, "kind">, expiresIn: jwt.SignOptions["expiresIn"] = "7d") {
  return jwt.sign({ kind: "download", ...payload }, env.JWT_SECRET, { expiresIn });
}

export function verifyDownloadToken(token: string): DownloadJwtPayload {
  const payload = jwt.verify(token, env.JWT_SECRET) as DownloadJwtPayload;
  if (payload?.kind !== "download" || !payload.fileId || !payload.companyId) throw new Error("Token de descarga inválido");
  return payload;
}
