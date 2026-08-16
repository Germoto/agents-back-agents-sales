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

export async function createAdCatalogEntry(
  companyId: string,
  data: { description: string; matchers: string[]; productId?: string | null },
) {
  const matchers = [...new Set(data.matchers.map((m) => m.trim()).filter(Boolean))];
  if (!matchers.length) throw new AppError("Agrega al menos un ID o título del anuncio", 422);
  await ensureProduct(companyId, data.productId);
  return prisma.adCatalogEntry.create({
    data: { companyId, description: data.description.trim(), matchers, productId: data.productId ?? null },
    include: { product: { select: { id: true, name: true } } },
  });
}

export async function updateAdCatalogEntry(
  companyId: string,
  id: string,
  data: { description?: string; matchers?: string[]; productId?: string | null },
) {
  const existing = await prisma.adCatalogEntry.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Entrada del catálogo no encontrada", 404);
  const matchers = data.matchers ? [...new Set(data.matchers.map((m) => m.trim()).filter(Boolean))] : undefined;
  if (matchers && !matchers.length) throw new AppError("Agrega al menos un ID o título del anuncio", 422);
  if (data.productId !== undefined) await ensureProduct(companyId, data.productId);
  return prisma.adCatalogEntry.update({
    where: { id },
    data: {
      ...(data.description !== undefined ? { description: data.description.trim() } : {}),
      ...(matchers ? { matchers } : {}),
      ...(data.productId !== undefined ? { productId: data.productId || null } : {}),
    },
    include: { product: { select: { id: true, name: true } } },
  });
}

export async function deleteAdCatalogEntry(companyId: string, id: string) {
  const existing = await prisma.adCatalogEntry.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Entrada del catálogo no encontrada", 404);
  await prisma.adCatalogEntry.delete({ where: { id } });
}

export type AdCatalogResolved = { description: string; productId: string | null; productName: string | null };

/** Map matcher(normalizado) → {descripción, producto}, para resolver en lote. */
export async function resolveAdCatalog(companyId: string): Promise<Map<string, AdCatalogResolved>> {
  const entries = await listAdCatalog(companyId);
  const map = new Map<string, AdCatalogResolved>();
  for (const entry of entries) {
    for (const matcher of entry.matchers) {
      map.set(normalize(matcher), {
        description: entry.description,
        productId: entry.productId ?? null,
        productName: entry.product?.name ?? null,
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
