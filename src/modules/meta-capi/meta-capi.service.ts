/**
 * Meta Conversions API por tenant: CONFIGURACIÓN (dataset, token cifrado, página,
 * píxel de la tienda). El registro y envío de cada venta vive en
 * `meta-sales.service.ts` (punto único, con cola y reintentos).
 */

import { prisma } from "../../lib/prisma";
import { decryptCredential, encryptCredential } from "../../lib/credentials-crypto";

export {
  recordSaleForMeta,
  reportCtwaConversion,
  reportStorePurchase,
  cancelPendingOrderEvent,
  listMetaEvents,
  startMetaEventsWorker,
  type StoreWebClient,
} from "./meta-sales.service";

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
    pixelEnabled: config?.pixelEnabled ?? false,
    // Reportar también ventas de clientes sin clic de anuncio guardado.
    reportWithoutClick: config?.reportWithoutClick ?? false,
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
    pixelEnabled?: boolean;
    reportWithoutClick?: boolean;
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
    ...(data.pixelEnabled !== undefined ? { pixelEnabled: data.pixelEnabled } : {}),
    ...(data.reportWithoutClick !== undefined ? { reportWithoutClick: data.reportWithoutClick } : {}),
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

/** Pixel id para la tienda web (solo si CAPI está activo y el píxel habilitado). */
export async function storePixelId(companyId: string): Promise<string | null> {
  const config = await prisma.metaCapiConfig.findUnique({ where: { companyId }, select: { enabled: true, pixelEnabled: true, datasetId: true } });
  return config?.enabled && config.pixelEnabled && config.datasetId ? config.datasetId : null;
}
