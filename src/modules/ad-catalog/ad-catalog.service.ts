/**
 * Catálogo de anuncios: mapea uno o VARIOS identificadores del anuncio
 * (ad_source_id o ad_title, tal como llegan en el webhook CTWA) a una
 * descripción amigable. Al pintar un lead se muestra la descripción en vez
 * del ID crudo; el reporte por anuncio también la usa.
 */

import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

const normalize = (s: string) => s.trim().toLowerCase();

export async function listAdCatalog(companyId: string) {
  return prisma.adCatalogEntry.findMany({
    where: { companyId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function createAdCatalogEntry(companyId: string, data: { description: string; matchers: string[] }) {
  const matchers = [...new Set(data.matchers.map((m) => m.trim()).filter(Boolean))];
  if (!matchers.length) throw new AppError("Agrega al menos un ID o título del anuncio", 422);
  return prisma.adCatalogEntry.create({
    data: { companyId, description: data.description.trim(), matchers },
  });
}

export async function updateAdCatalogEntry(
  companyId: string,
  id: string,
  data: { description?: string; matchers?: string[] },
) {
  const existing = await prisma.adCatalogEntry.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Entrada del catálogo no encontrada", 404);
  const matchers = data.matchers ? [...new Set(data.matchers.map((m) => m.trim()).filter(Boolean))] : undefined;
  if (matchers && !matchers.length) throw new AppError("Agrega al menos un ID o título del anuncio", 422);
  return prisma.adCatalogEntry.update({
    where: { id },
    data: {
      ...(data.description !== undefined ? { description: data.description.trim() } : {}),
      ...(matchers ? { matchers } : {}),
    },
  });
}

export async function deleteAdCatalogEntry(companyId: string, id: string) {
  const existing = await prisma.adCatalogEntry.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Entrada del catálogo no encontrada", 404);
  await prisma.adCatalogEntry.delete({ where: { id } });
}

/** Map matcher(normalizado) → descripción, para resolver en lote. */
export async function resolveAdDescriptions(companyId: string): Promise<Map<string, string>> {
  const entries = await listAdCatalog(companyId);
  const map = new Map<string, string>();
  for (const entry of entries) {
    for (const matcher of entry.matchers) map.set(normalize(matcher), entry.description);
  }
  return map;
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
