import type { BusinessVertical, CompanySubscription, PlanModule, PlatformPlan } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";

// ============================================================
// Resolver de "entitlements" (derechos efectivos) de un tenant según su
// suscripción SaaS. Empresa SIN CompanySubscription = LEGACY: acceso libre
// sin límites (grandfathering de los tenants existentes en prod).
// ============================================================

export type BillingStatus = "LEGACY" | "ACTIVE" | "GRACE" | "CREDITS" | "EXPIRED" | "CANCELED";

export type Entitlements = {
  legacy: boolean;
  status: BillingStatus;
  /** true => acceso cortado: bot no responde y las escrituras del panel dan 403. */
  blocked: boolean;
  modules: PlanModule[];
  verticals: BusinessVertical[];
  monthlyLeadLimit: number | null;
  extraLeadPricePen: number | null;
  planId: string | null;
  planName: string | null;
  expiresAt: Date | null;
  graceEndsAt: Date | null;
  balancePen: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const ALL_MODULES: PlanModule[] = ["CAMPAIGNS", "CRM", "FLOWS", "QUICK_REPLIES", "FUNNEL", "META_PROVIDER"];
const ALL_VERTICALS: BusinessVertical[] = [
  "INFOPRODUCT",
  "PHYSICAL_GOODS",
  "RESTAURANT",
  "STREAMER",
  "SERVICE",
  "OTHER",
];

function legacyEntitlements(balancePen = 0): Entitlements {
  return {
    legacy: true,
    status: "LEGACY",
    blocked: false,
    modules: ALL_MODULES,
    verticals: ALL_VERTICALS,
    monthlyLeadLimit: null,
    extraLeadPricePen: null,
    planId: null,
    planName: null,
    expiresAt: null,
    graceEndsAt: null,
    balancePen,
  };
}

type SubWithPlan = CompanySubscription & { plan: PlatformPlan };

/**
 * Estado derivado de la suscripción (no se persiste):
 *  ACTIVE -> GRACE (BILLING_GRACE_DAYS) -> CREDITS (hay saldo y el plan tiene
 *  precio por lead extra) -> EXPIRED (blocked). CANCELED corta en expiresAt
 *  sin gracia ni créditos.
 */
export function deriveBillingState(
  sub: SubWithPlan,
  balancePen: number,
  now = new Date(),
): { status: BillingStatus; blocked: boolean; graceEndsAt: Date } {
  const expiresMs = sub.expiresAt.getTime();
  const graceEndsAt = new Date(expiresMs + env.BILLING_GRACE_DAYS * DAY_MS);
  const nowMs = now.getTime();

  if (sub.canceledAt) {
    return { status: "CANCELED", blocked: nowMs >= expiresMs, graceEndsAt: sub.expiresAt };
  }
  if (nowMs < expiresMs) {
    return { status: "ACTIVE", blocked: false, graceEndsAt };
  }
  if (nowMs < graceEndsAt.getTime()) {
    return { status: "GRACE", blocked: false, graceEndsAt };
  }
  const extraLeadPrice = sub.plan.extraLeadPricePen;
  if (balancePen > 0 && extraLeadPrice !== null && Number(extraLeadPrice) > 0) {
    return { status: "CREDITS", blocked: false, graceEndsAt };
  }
  return { status: "EXPIRED", blocked: true, graceEndsAt };
}

function toEntitlements(sub: SubWithPlan, balancePen: number): Entitlements {
  const { status, blocked, graceEndsAt } = deriveBillingState(sub, balancePen);
  return {
    legacy: false,
    status,
    blocked,
    modules: sub.plan.modules,
    verticals: sub.plan.verticals,
    monthlyLeadLimit: sub.plan.monthlyLeadLimit,
    extraLeadPricePen: sub.plan.extraLeadPricePen === null ? null : Number(sub.plan.extraLeadPricePen),
    planId: sub.planId,
    planName: sub.plan.name,
    expiresAt: sub.expiresAt,
    graceEndsAt,
    balancePen,
  };
}

// Caché corta por empresa: el gate del agente corre en cada inbound y el
// middleware en cada request; 60s de TTL evita 2 queries por hit. Proceso
// único (igual que el debounce del agente), así que un Map basta.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { ent: Entitlements; ts: number }>();

export function invalidateEntitlements(companyId: string) {
  cache.delete(companyId);
}

export async function getEntitlements(companyId: string): Promise<Entitlements> {
  if (env.BILLING_ENFORCEMENT === "0") return legacyEntitlements();

  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.ent;

  const [sub, wallet] = await Promise.all([
    prisma.companySubscription.findUnique({ where: { companyId }, include: { plan: true } }),
    prisma.companyWallet.findUnique({ where: { companyId } }),
  ]);
  const balancePen = wallet ? Number(wallet.balancePen) : 0;
  const ent = sub ? toEntitlements(sub, balancePen) : legacyEntitlements(balancePen);
  cache.set(companyId, { ent, ts: Date.now() });
  return ent;
}

// ---------------------------------------------------------------
// Conteo de leads del mes calendario en la TZ del tenant.
// (Helpers de TZ replicados de dashboard.service.ts.)
// ---------------------------------------------------------------

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** Instante UTC de las 00:00 del día 1 del mes actual en la TZ del tenant. */
export function monthStartUtc(timeZone: string, now = new Date()): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value])) as Record<string, string>;
  const base = new Date(`${p.year}-${p.month}-01T00:00:00.000Z`);
  return new Date(base.getTime() - tzOffsetMs(base, timeZone));
}

/** Leads del mes = Customers creados este mes calendario (TZ del tenant). */
export async function countMonthlyLeads(companyId: string, timeZone: string, now = new Date()): Promise<number> {
  return prisma.customer.count({
    where: { companyId, createdAt: { gte: monthStartUtc(timeZone, now) } },
  });
}
