/**
 * Catálogo de anuncios: mapea uno o VARIOS identificadores del anuncio
 * (ad_source_id o ad_title, tal como llegan en el webhook CTWA) a una
 * descripción amigable. Al pintar un lead se muestra la descripción en vez
 * del ID crudo; el reporte por anuncio también la usa.
 */

import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

const normalize = (s: string) => s.trim().toLowerCase();

/** Valida que el producto (si viene) pertenezca al tenant. */
async function ensureProduct(companyId: string, productId: string | null | undefined) {
  if (!productId) return;
  const product = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!product) throw new AppError("Producto no encontrado", 404);
}

export async function listAdCatalog(companyId: string) {
  return prisma.adCatalogEntry.findMany({
    where: { companyId },
    include: { product: { select: { id: true, name: true } } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/** Acciones CRM al llegar el lead (etiquetas + columna). crmId y crmColumnId van juntos. */
export interface AdCrmActions {
  tagIds?: string[];
  crmId?: string | null;
  crmColumnId?: string | null;
}

function crmActionData(data: AdCrmActions) {
  if ((data.crmId && !data.crmColumnId) || (!data.crmId && data.crmColumnId)) {
    throw new AppError("Indica tablero y columna del CRM (o ninguno)", 422);
  }
  return {
    ...(data.tagIds !== undefined ? { tagIds: [...new Set(data.tagIds)] } : {}),
    ...(data.crmId !== undefined ? { crmId: data.crmId || null } : {}),
    ...(data.crmColumnId !== undefined ? { crmColumnId: data.crmColumnId || null } : {}),
  };
}

export async function createAdCatalogEntry(
  companyId: string,
  data: { description: string; matchers: string[]; productId?: string | null } & AdCrmActions,
) {
  const matchers = [...new Set(data.matchers.map((m) => m.trim()).filter(Boolean))];
  if (!matchers.length) throw new AppError("Agrega al menos un ID o título del anuncio", 422);
  await ensureProduct(companyId, data.productId);
  return prisma.adCatalogEntry.create({
    data: { companyId, description: data.description.trim(), matchers, productId: data.productId ?? null, ...crmActionData(data) },
    include: { product: { select: { id: true, name: true } } },
  });
}

export async function updateAdCatalogEntry(
  companyId: string,
  id: string,
  data: { description?: string; matchers?: string[]; productId?: string | null } & AdCrmActions,
) {
  const existing = await prisma.adCatalogEntry.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Entrada del catálogo no encontrada", 404);
  const matchers = data.matchers ? [...new Set(data.matchers.map((m) => m.trim()).filter(Boolean))] : undefined;
  if (matchers && !matchers.length) throw new AppError("Agrega al menos un ID o título del anuncio", 422);
  if (data.productId !== undefined) await ensureProduct(companyId, data.productId);
  // Tablero/columna: si solo viene uno, completar con el guardado para validar el par.
  const crm = {
    crmId: data.crmId !== undefined ? data.crmId : existing.crmId,
    crmColumnId: data.crmColumnId !== undefined ? data.crmColumnId : existing.crmColumnId,
  };
  return prisma.adCatalogEntry.update({
    where: { id },
    data: {
      ...(data.description !== undefined ? { description: data.description.trim() } : {}),
      ...(matchers ? { matchers } : {}),
      ...(data.productId !== undefined ? { productId: data.productId || null } : {}),
      ...crmActionData({ tagIds: data.tagIds, ...(data.crmId !== undefined || data.crmColumnId !== undefined ? crm : {}) }),
    },
    include: { product: { select: { id: true, name: true } } },
  });
}

export async function deleteAdCatalogEntry(companyId: string, id: string) {
  const existing = await prisma.adCatalogEntry.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Entrada del catálogo no encontrada", 404);
  await prisma.adCatalogEntry.delete({ where: { id } });
}

export type AdCatalogResolved = {
  id: string;
  description: string;
  productId: string | null;
  productName: string | null;
  tagIds: string[];
  crmId: string | null;
  crmColumnId: string | null;
};

/** Map matcher(normalizado) → {descripción, producto}, para resolver en lote. */
export async function resolveAdCatalog(companyId: string): Promise<Map<string, AdCatalogResolved>> {
  const entries = await listAdCatalog(companyId);
  const map = new Map<string, AdCatalogResolved>();
  for (const entry of entries) {
    for (const matcher of entry.matchers) {
      map.set(normalize(matcher), {
        id: entry.id,
        description: entry.description,
        productId: entry.productId ?? null,
        productName: entry.product?.name ?? null,
        tagIds: entry.tagIds ?? [],
        crmId: entry.crmId ?? null,
        crmColumnId: entry.crmColumnId ?? null,
      });
    }
  }
  return map;
}

/** Compat: map matcher → descripción (badges). */
export async function resolveAdDescriptions(companyId: string): Promise<Map<string, string>> {
  const full = await resolveAdCatalog(companyId);
  return new Map([...full.entries()].map(([k, v]) => [k, v.description]));
}

/** Entrada resuelta para un lead (por su adSourceId o adTitle). */
export function adCatalogEntryFor(
  map: Map<string, AdCatalogResolved>,
  adSourceId: string | null | undefined,
  adTitle: string | null | undefined,
): AdCatalogResolved | null {
  return (
    (adSourceId ? map.get(normalize(adSourceId)) : undefined) ??
    (adTitle ? map.get(normalize(adTitle)) : undefined) ??
    null
  );
}

/** Info de anuncio de un lead con la descripción resuelta (null si no vino de anuncio). */
export function adInfoFor(
  map: Map<string, string>,
  adSourceId: string | null | undefined,
  adTitle: string | null | undefined,
): { sourceId: string | null; title: string | null; description: string | null } | null {
  if (!adSourceId && !adTitle) return null;
  const description =
    (adSourceId ? map.get(normalize(adSourceId)) : undefined) ??
    (adTitle ? map.get(normalize(adTitle)) : undefined) ??
    null;
  return { sourceId: adSourceId ?? null, title: adTitle ?? null, description };
}
