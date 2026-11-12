/**
 * URL pública de la tienda SOLO si está "viva" (empresa con slug válido, tienda
 * activada y módulo STOREFRONT en el plan). Módulo pequeño sin dependencias del
 * agente para que agent-tools pueda importarlo sin ciclos.
 */
import { prisma } from "../../lib/prisma";
import { storeSlugProblem } from "../../lib/slug";
import { getEntitlements } from "../billing/entitlements";
import { storeUrl } from "./storefront-url";
import { isSimplePhysicalProduct, physicalSettingsOf, storeKindOf } from "./storefront-physical";

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

export interface AgentStoreLinks {
  url: string;
  products: { name: string; url: string }[];
  /** Productos publicados que no entraron en la lista (tope del prompt). */
  more: number;
}

const AGENT_LINKS_MAX = 40;

/**
 * Enlaces de la tienda de productos físicos para el agente: la URL de la tienda y la
 * ficha de cada producto publicado. null si el negocio no encendió «El agente comparte
 * la tienda», si la tienda no es de productos físicos o si no está viva.
 */
export async function agentStoreLinks(companyId: string): Promise<AgentStoreLinks | null> {
  const cfg = await prisma.storefrontConfig.findUnique({
    where: { companyId },
    select: { enabled: true, physical: true, productIds: true },
  });
  if (!cfg?.enabled || !physicalSettingsOf(cfg.physical).agentShareLinks) return null;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { vertical: true } });
  if (storeKindOf(company?.vertical, cfg.physical) !== "PHYSICAL") return null;
  const url = await publicStoreUrlIfLive(companyId);
  if (!url) return null;
  const rows = await prisma.product.findMany({
    where: { companyId, active: true, showInCatalog: true, productType: "PHYSICAL", ...(cfg.productIds.length ? { id: { in: cfg.productIds } } : {}) },
    select: { name: true, slug: true, price: true, verticalData: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const published = rows.filter(isSimplePhysicalProduct);
  return {
    url,
    products: published.slice(0, AGENT_LINKS_MAX).map((p) => ({ name: p.name, url: `${url}/p/${p.slug}` })),
    more: Math.max(0, published.length - AGENT_LINKS_MAX),
  };
}
