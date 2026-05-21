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
  account?: string | null;
  isActive: boolean;
  defaultServerId?: number | null;
}, callerPhone?: string) {
  // Si se está estableciendo (o cambiando) una cuenta vinculada, validamos
  // que el teléfono de WhatsApp del `unique` en SMSTools coincida con el
  // teléfono del usuario logueado (no con el adminPhone de la empresa).
  if (data.account && callerPhone) {
    const current = await prisma.whatsappConfig.findUnique({ where: { companyId } });
    const changed = !current || current.account !== data.account;
    if (changed) {
      const creds: SmsToolsCredentials = { apiUrl: data.apiUrl, secret: data.secret };
      const accounts = await smsTools.getAccounts(creds, 1, 100);
      const match = accounts.find((a) => a.unique === data.account);
      if (!match) {
        throw new AppError(
          "La cuenta de WhatsApp no se encontró en SMSTools con tus credenciales.",
          404,
        );
      }
      const accountPhone = normalizePhone(match.phone);
      const userPhone = normalizePhone(callerPhone);
      if (!accountPhone || !userPhone || accountPhone !== userPhone) {
        throw new AppError(
          `El número vinculado (${match.phone ?? "desconocido"}) no coincide con el número registrado para tu cuenta (${callerPhone}). Solo puedes vincular tu propio WhatsApp.`,
          403,
        );
      }
    }
  }

  return prisma.whatsappConfig.upsert({
    where: { companyId },
    update: data,
    create: {
      companyId,
      ...data,
    },
  });
}

/**
 * Normaliza un número telefónico a solo dígitos para comparar de forma
 * tolerante (ignora "+", espacios, guiones, paréntesis). Devuelve null si la
 * cadena no contiene dígitos suficientes.
 */
function normalizePhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D+/g, "");
  return digits.length >= 7 ? digits : null;
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

/**
 * Sincroniza el campo `account` del panel con el estado real en SMSTools.
 *
 * Comportamiento:
 *  - Lista las cuentas en SMSTools usando el `secret` de la empresa.
 *  - Busca la que coincida con el teléfono del usuario logueado.
 *  - Si la encuentra, actualiza el DB con su `unique` (incluso si era distinta).
 *  - Si no la encuentra, limpia el `account` del DB.
 *
 * Cubre los dos escenarios opuestos:
 *  - Local tiene unique pero ya no existe en SMSTools → limpia.
 *  - SMSTools tiene cuenta del usuario pero local no la tiene → vincula.
 */
export async function syncWhatsappAccount(companyId: string, callerPhone: string) {
  const config = await prisma.whatsappConfig.findUnique({ where: { companyId } });
  if (!config) {
    throw new AppError("Aún no has configurado la API de WhatsApp.", 400);
  }
  const creds: SmsToolsCredentials = { apiUrl: config.apiUrl, secret: config.secret };
  const accounts = await smsTools.getAccounts(creds, 1, 100);
  const userPhone = normalizePhone(callerPhone);
  const match = userPhone
    ? accounts.find((a) => normalizePhone(a.phone) === userPhone)
    : undefined;

  const nextAccount = match?.unique ?? null;
  if (nextAccount === config.account) {
    return {
      action: "unchanged" as const,
      account: config.account,
      phone: match?.phone ?? null,
      status: match?.status ?? null,
      config,
    };
  }

  const updated = await prisma.whatsappConfig.update({
    where: { companyId },
    data: { account: nextAccount },
  });

  return {
    action: nextAccount ? ("linked" as const) : ("unlinked" as const),
    account: nextAccount,
    phone: match?.phone ?? null,
    status: match?.status ?? null,
    config: updated,
  };
}

export async function createWhatsappLink(companyId: string, sid?: number) {
  const creds = await getCredentials(companyId);
  return smsTools.createLink(creds, sid);
}

async function assertAccountBelongsToCompany(
  creds: SmsToolsCredentials,
  unique: string,
): Promise<void> {
  // Cada empresa usa su propio secret; SMSTools solo lista las cuentas
  // vinculadas a ese secret. Si el `unique` no aparece, significa que no
  // pertenece a la empresa (o ya fue eliminado en SMSTools).
  const accounts = await smsTools.getAccounts(creds, 1, 100);
  const exists = accounts.some((a) => a.unique === unique);
  if (!exists) {
    throw new AppError(
      "La cuenta de WhatsApp no pertenece a tu organización o ya fue eliminada en SMSTools.",
      404,
    );
  }
}

export async function relinkWhatsappAccount(companyId: string, unique: string, sid?: number) {
  const creds = await getCredentials(companyId);
  await assertAccountBelongsToCompany(creds, unique);
  return smsTools.relinkAccount(creds, unique, sid);
}

export async function deleteWhatsappAccount(companyId: string, unique: string) {
  const creds = await getCredentials(companyId);
  await assertAccountBelongsToCompany(creds, unique);
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

export async function listWhatsappPending(companyId: string, page = 1, limit = 20) {
  const creds = await getCredentials(companyId);
  return fetchAndPaginate(companyId, (p, l) => smsTools.getPending(creds, p, l), page, limit);
}

export async function listWhatsappSent(companyId: string, page = 1, limit = 20) {
  const creds = await getCredentials(companyId);
  return fetchAndPaginate(companyId, (p, l) => smsTools.getSent(creds, p, l), page, limit);
}

export async function listWhatsappReceived(companyId: string, page = 1, limit = 20) {
  const creds = await getCredentials(companyId);
  return fetchAndPaginate(companyId, (p, l) => smsTools.getReceived(creds, p, l), page, limit);
}

/**
 * Dado que SMSTools ignora cualquier filtro por cuenta, traemos en lotes de 100
 * desde la API, filtramos por la cuenta vinculada y devolvemos la "página"
 * real que pidió el cliente. Así el paginado es correcto aunque haya mensajes
 * de otras cuentas mezclados.
 *
 * Devuelve { items, hasMore } para que el frontend sepa si habilitar "Siguiente".
 */
async function fetchAndPaginate<T extends { account?: string | null }>(
  companyId: string,
  fetcher: (page: number, limit: number) => Promise<T[]>,
  targetPage: number,
  pageSize: number,
): Promise<{ items: T[]; hasMore: boolean }> {
  const phone = await getLinkedPhone(companyId);
  if (!phone) return { items: [], hasMore: false };

  const BATCH = 100;
  const needed = targetPage * pageSize; // cuántos ítems filtrados necesitamos ver
  const filtered: T[] = [];
  let apiPage = 1;

  // Traemos lotes hasta tener suficiente o quedarnos sin datos
  while (filtered.length < needed + pageSize) {
    const batch = await fetcher(apiPage, BATCH);
    if (!batch?.length) break;
    filtered.push(...batch.filter((m) => m.account === phone));
    if (batch.length < BATCH) break; // último lote
    apiPage++;
  }

  const start = (targetPage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);
  const hasMore = filtered.length > start + pageSize;
  return { items, hasMore };
}

/** Resuelve el teléfono real (+51...) de la cuenta `unique` almacenada en config. */
async function getLinkedPhone(companyId: string): Promise<string | null> {
  const config = await prisma.whatsappConfig.findUnique({
    where: { companyId },
    select: { account: true },
  });
  const unique = config?.account ?? null;
  if (!unique) return null;

  const creds = await getCredentials(companyId);
  const accounts = await smsTools.getAccounts(creds).catch(() => [] as Array<{ unique?: string; phone?: string }>);
  return accounts.find((a) => a.unique === unique)?.phone ?? null;
}

export async function deleteWhatsappSent(companyId: string, id: number | string) {
  const creds = await getCredentials(companyId);
  return smsTools.deleteSent(creds, id);
}

export async function deleteWhatsappReceived(companyId: string, id: number | string) {
  const creds = await getCredentials(companyId);
  return smsTools.deleteReceived(creds, id);
}
