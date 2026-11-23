/**
 * Toques de anuncio (CTWA): cada vez que un cliente escribe desde un anuncio de
 * Meta queda una fila en AdTouch, sea su primer mensaje o vuelva meses después por
 * OTRO anuncio. En la ficha del cliente se conserva el PRIMER anuncio (origen) y se
 * actualiza el ÚLTIMO (el que se usa para reportar la compra a Meta).
 *
 * El mensaje entrante solo escribe en la base (toque + ficha). Lo que cambia la
 * conversación (disparador de flujos, producto en foco) lo aplica el TURNO al
 * consumir el toque pendiente: así no se pisa con el guardado del estado del turno.
 */

import { prisma } from "../../lib/prisma";
import { adCatalogEntryFor, resolveAdCatalog } from "./ad-catalog.service";

type CatalogEntry = NonNullable<ReturnType<typeof adCatalogEntryFor>>;

export interface AdTouchInput {
  companyId: string;
  customerId: string;
  conversationId?: string | null;
  adSourceId: string;
  adTitle?: string | null;
  ctwaClid?: string | null;
  adSourceUrl?: string | null;
  sourceType?: string | null;
  messageId?: string | null;
}

export interface AdTouchResult {
  /** true = clic nuevo (no un webhook repetido ni otro mensaje del mismo clic). */
  isNew: boolean;
  /** true = es el primer anuncio del cliente. */
  isFirst: boolean;
  entry: CatalogEntry | null;
}

/** Un toque sin atender por más de este tiempo ya no dispara nada (chat pausado, etc.). */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Sin click-id (anuncios en Estados): el mismo anuncio dentro de esta ventana es el mismo clic. */
const SAME_CLICK_WINDOW_MS = 30 * 60 * 1000;

/**
 * Registra el clic de anuncio de un mensaje entrante. Idempotente: un webhook
 * repetido (mismo messageId) o un segundo mensaje del mismo clic (mismo click-id)
 * no crean otro toque. Nunca lanza.
 */
export async function recordAdTouch(input: AdTouchInput): Promise<AdTouchResult> {
  const none: AdTouchResult = { isNew: false, isFirst: false, entry: null };
  try {
    const ctwaClid = input.ctwaClid?.trim() || null;
    const adTitle = input.adTitle?.trim() || null;
    const entry = adCatalogEntryFor(await resolveAdCatalog(input.companyId), input.adSourceId, adTitle) ?? null;

    const same = await prisma.adTouch.findFirst({
      where: {
        customerId: input.customerId,
        OR: [
          ...(input.messageId ? [{ messageId: input.messageId }] : []),
          ...(ctwaClid
            ? [{ ctwaClid }]
            : [{ adSourceId: input.adSourceId, createdAt: { gte: new Date(Date.now() - SAME_CLICK_WINDOW_MS) } }]),
        ],
      },
      select: { id: true },
    });
    if (same) return { ...none, entry };

    const now = new Date();
    try {
      await prisma.adTouch.create({
        data: {
          companyId: input.companyId,
          customerId: input.customerId,
          conversationId: input.conversationId ?? null,
          adSourceId: input.adSourceId,
          adTitle,
          ctwaClid,
          adSourceUrl: input.adSourceUrl?.trim() || null,
          sourceType: input.sourceType?.trim() || null,
          messageId: input.messageId ?? null,
          entryId: entry?.id ?? null,
          createdAt: now,
        },
      });
    } catch (err) {
      // Otro proceso registró el mismo mensaje a la vez.
      if ((err as { code?: string })?.code === "P2002") return { ...none, entry };
      throw err;
    }

    // Ficha: el PRIMER anuncio se fija una sola vez; el ÚLTIMO se actualiza siempre.
    const first = await prisma.customer.updateMany({
      where: { id: input.customerId, adSourceId: null },
      data: { adSourceId: input.adSourceId, adTitle, ctwaClid, adSourceUrl: input.adSourceUrl?.trim() || null },
    });
    await prisma.customer.updateMany({
      where: { id: input.customerId },
      data: { lastAdSourceId: input.adSourceId, lastAdTitle: adTitle, lastCtwaClid: ctwaClid, lastAdAt: now },
    });
    return { isNew: true, isFirst: first.count > 0, entry };
  } catch (err) {
    console.error("[ads] no se pudo registrar el clic de anuncio:", err instanceof Error ? err.message : err);
    return none;
  }
}

export interface PendingAdTouch {
  adSourceId: string;
  adTitle: string | null;
  entryId: string | null;
  /** Producto ligado al anuncio en el catálogo (si lo hay y sigue existiendo). */
  productId: string | null;
  at: string;
}

/**
 * Toma el clic de anuncio aún no atendido por la conversación (el más reciente) y
 * marca todos como atendidos. Lo llama el turno UNA vez; devuelve null si no hay.
 */
export async function consumePendingAdTouch(companyId: string, customerId: string): Promise<PendingAdTouch | null> {
  try {
    const pending = await prisma.adTouch.findFirst({
      where: { companyId, customerId, flowConsumedAt: null },
      orderBy: { createdAt: "desc" },
      select: { adSourceId: true, adTitle: true, entryId: true, createdAt: true },
    });
    if (!pending) return null;
    const claimed = await prisma.adTouch.updateMany({
      where: { companyId, customerId, flowConsumedAt: null },
      data: { flowConsumedAt: new Date() },
    });
    if (!claimed.count) return null;
    if (Date.now() - pending.createdAt.getTime() > PENDING_TTL_MS) return null;
    // El catálogo pudo cambiar desde el clic: se resuelve de nuevo (por id del anuncio o título).
    const entry = adCatalogEntryFor(await resolveAdCatalog(companyId), pending.adSourceId, pending.adTitle);
    return {
      adSourceId: pending.adSourceId,
      adTitle: pending.adTitle,
      entryId: entry?.id ?? pending.entryId ?? null,
      productId: entry?.productId ?? null,
      at: pending.createdAt.toISOString(),
    };
  } catch (err) {
    console.error("[ads] no se pudo leer el clic de anuncio pendiente:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Historial de anuncios de un cliente (más reciente primero), para la ficha y el Copiloto. */
export async function listAdTouches(companyId: string, customerId: string, limit = 20) {
  return prisma.adTouch.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 50),
    select: { id: true, adSourceId: true, adTitle: true, sourceType: true, createdAt: true },
  });
}
