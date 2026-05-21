import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { smsTools, type SmsToolsCredentials } from "../../lib/smstools-client";

async function getCredentials(companyId: string): Promise<SmsToolsCredentials> {
  const config = await prisma.whatsappConfig.findUnique({ where: { companyId } });
  if (!config) {
    throw new AppError("Aun no has configurado la API de WhatsApp.", 400);
  }
  if (!config.secret || !config.apiUrl) {
    throw new AppError("La configuracion de WhatsApp esta incompleta.", 400);
  }
  return { apiUrl: config.apiUrl, secret: config.secret };
}

function getProviderFailureReason(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const body = payload as {
    status?: number;
    message?: string;
    data?: unknown;
  };

  if (typeof body.status === "number" && body.status >= 400) {
    return body.message ?? "El proveedor devolvio un estado de error.";
  }

  if (body.data === false) {
    return body.message ?? "El proveedor indico que la prueba no fue exitosa.";
  }

  return null;
}

export async function getWhatsappConfig(companyId: string) {
  return prisma.whatsappConfig.findUnique({ where: { companyId } });
}

export async function upsertWhatsappConfig(companyId: string, data: {
  apiUrl: string;
  secret: string;
  account: string;
  isActive: boolean;
  defaultServerId?: number | null;
}) {
  return prisma.whatsappConfig.upsert({
    where: { companyId },
    update: data,
    create: {
      companyId,
      ...data,
    },
  });
}

export async function testWhatsappConnection(data: {
  apiUrl: string;
  secret: string;
  account: string;
  recipient: string;
  message: string;
}) {
  const formData = new FormData();
  formData.append("secret", data.secret);
  formData.append("account", data.account);
  formData.append("recipient", data.recipient);
  formData.append("type", "text");
  formData.append("message", data.message);

  let response: Response;

  try {
    response = await fetch(data.apiUrl, {
      method: "POST",
      body: formData,
    });
  } catch (error) {
    throw new AppError(
      error instanceof Error ? `No se pudo conectar con la API de WhatsApp: ${error.message}` : "No se pudo conectar con la API de WhatsApp",
      502,
    );
  }

  const rawText = await response.text();
  let parsedBody: unknown = null;

  try {
    parsedBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsedBody = rawText;
  }

  if (!response.ok) {
    throw new AppError("La API de WhatsApp respondio con error durante la prueba de conexion", 502, parsedBody);
  }

  const providerFailureReason = getProviderFailureReason(parsedBody);
  if (providerFailureReason) {
    throw new AppError(
      `La prueba no fue aceptada por el proveedor: ${providerFailureReason}. Revisa tu configuracion y el numero de prueba.`,
      502,
      parsedBody,
    );
  }

  return {
    success: true,
    statusCode: response.status,
    message: "Conexion verificada y mensaje de prueba enviado correctamente.",
    providerResponse: parsedBody,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * SMS TOOLS WhatsApp management (servers, accounts, QR linking, messages)
 * ──────────────────────────────────────────────────────────────────────────── */

export async function listWhatsappServers(companyId: string) {
  const creds = await getCredentials(companyId);
  return smsTools.getServers(creds);
}

export async function listWhatsappAccounts(companyId: string, page?: number, limit?: number) {
  const creds = await getCredentials(companyId);
  return smsTools.getAccounts(creds, page, limit);
}

export async function createWhatsappLink(companyId: string, sid?: number) {
  const creds = await getCredentials(companyId);
  return smsTools.createLink(creds, sid);
}

export async function relinkWhatsappAccount(companyId: string, unique: string, sid?: number) {
  const creds = await getCredentials(companyId);
  return smsTools.relinkAccount(creds, unique, sid);
}

export async function deleteWhatsappAccount(companyId: string, unique: string) {
  const creds = await getCredentials(companyId);
  return smsTools.deleteAccount(creds, unique);
}

export async function getWhatsappQrImage(companyId: string, token: string) {
  const creds = await getCredentials(companyId);
  return smsTools.getQrImage(creds, token);
}

export async function getWhatsappLinkInfo(companyId: string, token: string) {
  const creds = await getCredentials(companyId);
  return smsTools.getLinkInfo(creds, token);
}

export async function listWhatsappPending(companyId: string, page?: number, limit?: number) {
  const creds = await getCredentials(companyId);
  return smsTools.getPending(creds, page, limit);
}

export async function listWhatsappSent(companyId: string, page?: number, limit?: number) {
  const creds = await getCredentials(companyId);
  return smsTools.getSent(creds, page, limit);
}

export async function listWhatsappReceived(companyId: string, page?: number, limit?: number) {
  const creds = await getCredentials(companyId);
  return smsTools.getReceived(creds, page, limit);
}

export async function deleteWhatsappSent(companyId: string, id: number | string) {
  const creds = await getCredentials(companyId);
  return smsTools.deleteSent(creds, id);
}

export async function deleteWhatsappReceived(companyId: string, id: number | string) {
  const creds = await getCredentials(companyId);
  return smsTools.deleteReceived(creds, id);
}
