/**
 * URL pública de la tienda SOLO si está "viva" (empresa con slug válido, tienda
 * activada y módulo STOREFRONT en el plan). Módulo pequeño sin dependencias del
 * agente para que agent-tools pueda importarlo sin ciclos.
 */
import { prisma } from "../../lib/prisma";
import { storeSlugProblem } from "../../lib/slug";
import { getEntitlements } from "../billing/entitlements";
import { storeUrl } from "./storefront-url";

export async function publicStoreUrlIfLive(
  companyId: string,
  utm?: { source: string; campaign: string },
): Promise<string | null> {
  const [company, cfg, ent] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { slug: true, isActive: true } }),
    prisma.storefrontConfig.findUnique({ where: { companyId }, select: { enabled: true } }),
    getEntitlements(companyId),
  ]);
  if (!company?.isActive || !cfg?.enabled) return null;
  if (storeSlugProblem(company.slug)) return null;
  if (!(ent.legacy || ent.modules.includes("STOREFRONT"))) return null;
  const url = storeUrl(company.slug);
  if (!utm) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", utm.source);
    u.searchParams.set("utm_campaign", utm.campaign);
    return u.toString();
  } catch {
    return url;
  }
}
