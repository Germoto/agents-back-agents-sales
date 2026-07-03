import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { smsTools, type SmsToolsCredentials } from "../../lib/smstools-client";
import { metaWa } from "../../lib/meta-wa-client";
import { encryptCredential, decryptCredential } from "../../lib/credentials-crypto";
import { env } from "../../config/env";
import { getEntitlements } from "../billing/entitlements";

/** El proveedor META es un módulo de paquete: las empresas legacy pasan. */
async function assertMetaAllowedByPlan(companyId: string) {
  const ent = await getEntitlements(companyId);
  if (!ent.legacy && !ent.modules.includes("META_PROVIDER")) {
    throw new AppError("Tu plan no incluye la API oficial de Meta. Mejora tu paquete para activarla.", 403, {
      code: "MODULE_NOT_AVAILABLE",
    });
  }
}

async function getCredentials(companyId: string): Promise<SmsToolsCredentials> {
  const config = await prisma.whatsappConfig.findUnique({ where: { companyId } });
  if (!config) {
    throw new AppError("Aun no has configurado la API de WhatsApp.", 400);
  }
  // Protege de una vez TODOS los endpoints SMS Tools (QR, servers, accounts,
  // messages): no aplican cuando el canal del tenant es la API oficial de Meta.
  if (config.provider === "META") {
    throw new AppError("Esta operación corresponde al proveedor SMS Tools; tu canal usa la API oficial de Meta.", 400);
  }
  if (!config.secret || !config.apiUrl) {
    throw new AppError("La configuracion de WhatsApp esta incompleta.", 400);
  }
  return { apiUrl: config.apiUrl, secret: config.secret };
}

/** Enmascara el token para respuestas del API: nunca se devuelve completo. */
function maskToken(token: string | null): string | null {
  if (!token) return null;
  const plain = decryptCredential(token);
  if (!plain) return null;
  return `•••${plain.slice(-4)}`;
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
  const config = await prisma.whatsappConfig.findUnique({ where: { companyId } });
  if (!config) return null;
  // El token de Meta jamás sale completo del backend.
  return { ...config, metaAccessToken: maskToken(config.metaAccessToken) };
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

  // Guardar credenciales NO cambia el proveedor activo: eso ahora es exclusivo
  // del toggle explícito (setActiveProvider). En creación, `provider` toma el
  // default del schema (SMSTOOLS).
  return prisma.whatsappConfig.upsert({
    where: { companyId },
    update: { ...data },
    create: {
      companyId,
      ...data,
    },
  });
}

/**
 * Cambia el proveedor activo del canal (SMS Tools ⇄ Meta) sin tocar
 * credenciales. Es no destructivo: el secret de SMS Tools y las credenciales de
 * Meta se conservan, así que se puede ir y volver. Valida que existan los
 * prerequisitos del proveedor destino antes de activarlo.
 */
export async function setActiveProvider(companyId: string, provider: "SMSTOOLS" | "META") {
  const config = await prisma.whatsappConfig.findUnique({ where: { companyId } });
  if (!config) {
    throw new AppError("Aún no has configurado la API de WhatsApp.", 400);
  }
  if (provider === "SMSTOOLS" && !config.secret) {
    throw new AppError("No hay credenciales de SMS Tools configuradas para esta cuenta.", 400);
  }
  if (provider === "META" && (!config.metaPhoneNumberId || !config.metaAccessToken)) {
    throw new AppError("Faltan credenciales de la API de Meta. Complétalas antes de activarla.", 400);
  }
  if (provider === "META") {
    await assertMetaAllowedByPlan(companyId);
  }
  if (config.provider === provider) {
    // Ya está activo: idempotente, devolvemos la config saneada.
    return { ...config, metaAccessToken: maskToken(config.metaAccessToken) };
  }
  const updated = await prisma.whatsappConfig.update({
    where: { companyId },
    data: { provider },
  });
  return { ...updated, metaAccessToken: maskToken(updated.metaAccessToken) };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Meta WhatsApp Cloud API (proveedor oficial)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Guarda las credenciales de Meta y activa el proveedor META. Valida el token
 * y el Phone Number ID contra la API de Graph ANTES de guardar (si no, 400 con
 * el error del proveedor). `accessToken` vacío conserva el token ya guardado
 * (el frontend lo muestra enmascarado).
 */
export async function updateMetaConfig(
  companyId: string,
  data: { accessToken?: string | null; phoneNumberId: string; wabaId?: string | null; isActive: boolean },
) {
  await assertMetaAllowedByPlan(companyId);
  const current = await prisma.whatsappConfig.findUnique({ where: { companyId } });

  let plainToken = (data.accessToken ?? "").trim();
  if (!plainToken) {
    plainToken = decryptCredential(current?.metaAccessToken);
    if (!plainToken) {
      throw new AppError("Ingresa el token de acceso de Meta (System User).", 400);
    }
  }

  // Validación en vivo: si el token o el phone number id no sirven, no guardamos.
  const info = await metaWa.getPhoneNumberInfo({ accessToken: plainToken, phoneNumberId: data.phoneNumberId });

  // Otro tenant no puede reclamar el mismo número (índice único + chequeo amable).
  const clash = await prisma.whatsappConfig.findFirst({
    where: { metaPhoneNumberId: data.phoneNumberId, companyId: { not: companyId } },
    select: { id: true },
  });
  if (clash) {
    throw new AppError("Ese Phone Number ID ya está vinculado a otra cuenta de la plataforma.", 409);
  }

  // Guardar credenciales de Meta NO cambia el proveedor activo (eso es del
  // toggle explícito). EXCEPTO al crear la fila por primera vez: si no existía
  // config, el default del schema sería SMSTOOLS y sin secret quedaría en un
  // estado inconsistente, así que en creación arrancamos en META.
  const metaData = {
    metaAccessToken: encryptCredential(plainToken),
    metaPhoneNumberId: data.phoneNumberId,
    metaWabaId: data.wabaId?.trim() || null,
    metaDisplayPhone: info.displayPhone,
    isActive: data.isActive,
  };

  const saved = await prisma.whatsappConfig.upsert({
    where: { companyId },
    update: metaData,
    create: {
      companyId,
      provider: "META",
      // Columnas legacy de SMS Tools (NOT NULL): inertes para el proveedor META.
      apiUrl: env.SMSTOOLS_API_URL,
      secret: "",
      ...metaData,
    },
  });

  const warnings: string[] = [];
  if (!env.PUBLIC_BASE_URL.startsWith("https://")) {
    warnings.push(
      "PUBLIC_BASE_URL no es HTTPS público: Meta no podrá descargar la multimedia saliente (archivos de productos, imágenes).",
    );
  }

  // Suscribir NUESTRA app al WABA para recibir los mensajes entrantes en el
  // webhook. Es el paso que Meta no hace solo (con el número de prueba el WABA
  // queda suscrito a la app interna de Meta). Best-effort: si falla, el envío y
  // la validación ya quedaron guardados; solo avisamos que la recepción no
  // funcionará hasta resolverlo.
  if (data.wabaId?.trim()) {
    try {
      await metaWa.subscribeAppToWaba(plainToken, data.wabaId.trim());
    } catch (err) {
      warnings.push(
        `No se pudo suscribir la app al WABA automáticamente (los mensajes entrantes podrían no llegar): ${
          err instanceof Error ? err.message : "error desconocido"
        }. Verifica que el token tenga el permiso whatsapp_business_management.`,
      );
    }
  } else {
    warnings.push(
      "Sin WABA ID no se pudo suscribir la app para recibir mensajes entrantes. Agrega el WABA ID y vuelve a guardar.",
    );
  }

  return {
    config: { ...saved, metaAccessToken: maskToken(saved.metaAccessToken) },
    info,
    warning: warnings.length ? warnings.join(" ") : null,
  };
}

/** Test de conexión en vivo del canal Meta (semáforo del panel). */
export async function getMetaStatus(companyId: string) {
  const config = await prisma.whatsappConfig.findUnique({ where: { companyId } });
  if (!config || config.provider !== "META" || !config.metaAccessToken || !config.metaPhoneNumberId) {
    return { connected: false, displayPhone: null, verifiedName: null, qualityRating: null, error: "Sin credenciales de Meta configuradas." };
  }
  try {
    const info = await metaWa.getPhoneNumberInfo({
      accessToken: decryptCredential(config.metaAccessToken),
      phoneNumberId: config.metaPhoneNumberId,
    });
    // Cache del número visible (lo usa getLinkedPhone/setup sin llamar a Graph).
    if (info.displayPhone && info.displayPhone !== config.metaDisplayPhone) {
      await prisma.whatsappConfig.update({ where: { companyId }, data: { metaDisplayPhone: info.displayPhone } });
    }
    return { connected: true, ...info, error: null };
  } catch (err) {
    return {
      connected: false,
      displayPhone: config.metaDisplayPhone,
      verifiedName: null,
      qualityRating: null,
      error: err instanceof Error ? err.message : "No se pudo verificar la conexión con Meta.",
    };
  }
}

/** Plantillas aprobadas del WABA (para recordatorios/campañas fuera de ventana). */
export async function listMetaTemplates(companyId: string) {
  const config = await prisma.whatsappConfig.findUnique({ where: { companyId } });
  if (!config || config.provider !== "META" || !config.metaAccessToken) {
    throw new AppError("El canal de esta cuenta no usa la API oficial de Meta.", 400);
  }
  if (!config.metaWabaId) {
    throw new AppError("Configura el WABA ID (WhatsApp Business Account) para listar plantillas.", 400);
  }
  const templates = await metaWa.listTemplates(decryptCredential(config.metaAccessToken), config.metaWabaId);
  return templates.filter((t) => t.status === "APPROVED");
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
export async function getLinkedPhone(companyId: string): Promise<string | null> {
  const config = await prisma.whatsappConfig.findUnique({
    where: { companyId },
    select: { account: true, provider: true, metaDisplayPhone: true },
  });
  // META: el número visible está cacheado en BD (no hay llamada a Graph aquí).
  if (config?.provider === "META") return config.metaDisplayPhone ?? null;
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
