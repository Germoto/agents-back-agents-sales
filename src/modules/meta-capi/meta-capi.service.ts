/**
 * Meta Conversions API (CTWA) por tenant: reporta cada venta APROBADA como
 * evento Purchase con el ctwa_clid del lead — Meta atribuye la conversión al
 * anuncio exacto y optimiza las campañas hacia COMPRADORES.
 *
 * Todo best-effort: si el tenant no configuró CAPI, el lead no vino de anuncio
 * o Meta falla, el flujo de aprobación sigue idéntico (never-throw).
 * Idempotencia: flag metadata.capiSentAt + event_id = receipt.id (Meta dedupea).
 */

import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { decryptCredential, encryptCredential } from "../../lib/credentials-crypto";

function maskToken(stored: string | null): string | null {
  if (!stored) return null;
  const plain = decryptCredential(stored);
  return plain ? `•••${plain.slice(-4)}` : null;
}

export async function getMetaCapiConfig(companyId: string) {
  const config = await prisma.metaCapiConfig.findUnique({ where: { companyId } });
  return {
    enabled: config?.enabled ?? false,
    datasetId: config?.datasetId ?? "",
    pageId: config?.pageId ?? "",
    accessTokenSet: !!config?.accessToken,
    accessTokenMasked: maskToken(config?.accessToken ?? null),
    testEventCode: config?.testEventCode ?? "",
    // Diagnóstico del último intento (para no depurar a ciegas desde el panel).
    lastAttemptAt: config?.lastAttemptAt ?? null,
    lastResult: config?.lastResult ?? null,
  };
}

export async function updateMetaCapiConfig(
  companyId: string,
  data: {
    enabled: boolean;
    datasetId: string;
    accessToken?: string;
    pageId?: string | null;
    testEventCode?: string | null;
  },
) {
  const existing = await prisma.metaCapiConfig.findUnique({ where: { companyId }, select: { id: true, accessToken: true } });
  const typedToken = data.accessToken?.trim();
  if (!existing && !typedToken && data.enabled) {
    // Primera vez activando: el token es obligatorio.
    return getMetaCapiConfig(companyId);
  }
  const core = {
    enabled: data.enabled,
    datasetId: data.datasetId.trim(),
    pageId: data.pageId?.trim() || null,
    testEventCode: data.testEventCode?.trim() || null,
    // Keep-if-empty: la key guardada se conserva salvo que tipeen una nueva.
    ...(typedToken ? { accessToken: encryptCredential(typedToken) } : {}),
  };
  if (existing) {
    await prisma.metaCapiConfig.update({ where: { companyId }, data: core });
  } else {
    await prisma.metaCapiConfig.create({
      data: { companyId, ...core, accessToken: encryptCredential(typedToken ?? "") },
    });
  }
  return getMetaCapiConfig(companyId);
}

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

/**
 * Reporta la venta de un comprobante APROBADO a Meta CAPI (fire-and-forget).
 * No-op silencioso si: CAPI no configurado/deshabilitado, el receipt no tiene
 * cliente o el cliente no tiene ctwa_clid, o ya se reportó (metadata.capiSentAt).
 */
/** Registra el resultado del último intento (visible en la card del panel). */
async function recordAttempt(companyId: string, result: string): Promise<void> {
  await prisma.metaCapiConfig
    .update({ where: { companyId }, data: { lastAttemptAt: new Date(), lastResult: result.slice(0, 500) } })
    .catch(() => undefined);
}

export async function reportCtwaConversion(companyId: string, receiptId: string): Promise<void> {
  try {
    const config = await prisma.metaCapiConfig.findUnique({ where: { companyId } });
    if (!config?.enabled || !config.datasetId || !config.accessToken) return;

    const receipt = await prisma.paymentReceipt.findFirst({
      where: { id: receiptId, companyId },
      select: {
        id: true,
        status: true,
        amountPaid: true,
        amountExpected: true,
        currency: true,
        occurredAt: true,
        validatedAt: true,
        metadata: true,
        customer: { select: { phone: true, ctwaClid: true } },
      },
    });
    if (!receipt || receipt.status !== "APROBADO") return;
    const ctwaClid = receipt.customer?.ctwaClid?.trim();
    if (!ctwaClid) {
      await recordAttempt(companyId, "Omitido: la venta no es de un lead con click-id de anuncio (no aplica).");
      return;
    }
    const meta = (receipt.metadata ?? {}) as Record<string, unknown>;
    if (meta.capiSentAt) {
      await recordAttempt(companyId, "Omitido: esta venta ya fue reportada antes (no se duplica).");
      return;
    }

    const value = Number(String(receipt.amountPaid ?? receipt.amountExpected).replace(/[^0-9.]/g, ""));
    const eventTime = Math.floor((receipt.occurredAt ?? receipt.validatedAt ?? new Date()).getTime() / 1000);
    const phoneDigits = (receipt.customer?.phone ?? "").replace(/\D/g, "");

    const body: Record<string, unknown> = {
      data: [
        {
          event_name: "Purchase",
          event_time: eventTime,
          event_id: receipt.id,
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          user_data: {
            ctwa_clid: ctwaClid,
            // Meta exige el page_id de la página que corre los anuncios en
            // eventos business_messaging.
            ...(config.pageId ? { page_id: config.pageId } : {}),
            ...(phoneDigits ? { ph: [sha256(phoneDigits)] } : {}),
          },
          custom_data: {
            currency: (receipt.currency || "PEN").toUpperCase(),
            ...(Number.isFinite(value) && value > 0 ? { value } : { value: 0 }),
          },
        },
      ],
      ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
    };

    const token = decryptCredential(config.accessToken);
    const url = `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${config.datasetId}/events?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[meta-capi] Meta respondió ${res.status}: ${detail.slice(0, 300)}`);
      await recordAttempt(companyId, `Error de Meta (${res.status}): ${detail.slice(0, 300)}`);
      return;
    }
    await prisma.paymentReceipt.update({
      where: { id: receipt.id },
      data: { metadata: { ...meta, capiSentAt: new Date().toISOString() } },
    });
    await recordAttempt(
      companyId,
      `OK: Purchase de ${(receipt.currency || "PEN").toUpperCase()} ${value} reportado${config.testEventCode ? ` (modo prueba ${config.testEventCode})` : ""}.`,
    );
    console.log(`[meta-capi] Purchase reportado (receipt=${receipt.id}, valor=${value}) con ctwa_clid`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "error desconocido";
    console.warn("[meta-capi] no se pudo reportar la conversión:", message);
    await recordAttempt(companyId, `Error: ${message}`).catch(() => undefined);
  }
}
