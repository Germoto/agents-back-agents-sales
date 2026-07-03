import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import {
  countMonthlyLeads,
  deriveBillingState,
  getEntitlements,
  invalidateEntitlements,
} from "./entitlements";

// ============================================================
// Dominio de monetización SaaS visto desde el TENANT: estado de mi plan,
// canje de vales (paquete o créditos) y cobro por lead extra.
// La administración (planes, suscripciones, lotes de vales, recargas)
// vive en billing-admin.service.ts.
// ============================================================

/** Suma meses en UTC con clamp de fin de mes (31-ene + 1m = 28/29-feb). */
export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------
// Estado de facturación del tenant (página "Mi plan" + banners).
// ---------------------------------------------------------------

export async function getBillingMe(companyId: string) {
  const [ent, company, wallet] = await Promise.all([
    getEntitlements(companyId),
    prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
    prisma.companyWallet.findUnique({ where: { companyId } }),
  ]);
  // El saldo se lee directo (no de la caché de entitlements) para que la UI
  // refleje recargas/cobros al instante.
  const balancePen = wallet ? Number(wallet.balancePen) : 0;
  const timezone = company?.timezone ?? "America/Lima";
  const leadsUsed = await countMonthlyLeads(companyId, timezone);

  // Datos completos del plan para la UI (la caché solo guarda lo de enforcement).
  const sub = ent.legacy
    ? null
    : await prisma.companySubscription.findUnique({ where: { companyId }, include: { plan: true } });

  return {
    legacy: ent.legacy,
    status: sub ? deriveBillingState(sub, balancePen).status : ent.status,
    plan: sub
      ? {
          id: sub.plan.id,
          name: sub.plan.name,
          description: sub.plan.description,
          priceUsd: Number(sub.plan.priceUsd),
          pricePen: Number(sub.plan.pricePen),
          monthlyLeadLimit: sub.plan.monthlyLeadLimit,
          extraLeadPricePen:
            sub.plan.extraLeadPricePen === null ? null : Number(sub.plan.extraLeadPricePen),
          modules: sub.plan.modules,
          verticals: sub.plan.verticals,
        }
      : null,
    startsAt: sub?.startsAt ?? null,
    expiresAt: sub?.expiresAt ?? null,
    graceEndsAt: sub ? deriveBillingState(sub, balancePen).graceEndsAt : null,
    canceledAt: sub?.canceledAt ?? null,
    leadUsage: { used: leadsUsed, limit: sub?.plan.monthlyLeadLimit ?? null },
    wallet: {
      balancePen,
      extraLeadPricePen:
        sub?.plan.extraLeadPricePen != null ? Number(sub.plan.extraLeadPricePen) : null,
    },
  };
}

export async function listMyCreditTransactions(companyId: string, limit = 50) {
  const rows = await prisma.creditTransaction.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((tx) => ({
    id: tx.id,
    type: tx.type,
    amountPen: Number(tx.amountPen),
    balanceAfterPen: Number(tx.balanceAfterPen),
    note: tx.note,
    customerPhone: tx.customerPhone,
    createdAt: tx.createdAt,
  }));
}

// ---------------------------------------------------------------
// Canje de vales (tenant). Claim atómico: el mismo código canjeado en
// paralelo solo le entra a uno.
// ---------------------------------------------------------------

export type RedeemResult =
  | { kind: "PLAN"; planName: string; months: number; expiresAt: Date }
  | { kind: "CREDIT"; amountPen: number; balancePen: number };

export async function redeemVoucher(companyId: string, userId: string, code: string): Promise<RedeemResult> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new AppError("Ingresa el código del vale", 422);

  const result = await prisma.$transaction(async (tx) => {
    // Mismo mensaje para "no existe" y "ya usado": no revelar qué códigos existen.
    const claimed = await tx.voucher.updateMany({
      where: { code: normalized, redeemedAt: null },
      data: { redeemedAt: new Date(), redeemedByCompanyId: companyId, redeemedByUserId: userId },
    });
    if (claimed.count === 0) {
      throw new AppError("Este vale ya fue utilizado o no existe", 409, { code: "VOUCHER_INVALID" });
    }
    const voucher = await tx.voucher.findUnique({ where: { code: normalized }, include: { plan: true } });
    if (!voucher) throw new AppError("Este vale ya fue utilizado o no existe", 409, { code: "VOUCHER_INVALID" });

    if (voucher.type === "CREDIT") {
      const amount = Number(voucher.creditAmountPen ?? 0);
      if (amount <= 0) throw new AppError("Vale de créditos mal configurado", 409, { code: "VOUCHER_INVALID" });
      const wallet = await tx.companyWallet.upsert({
        where: { companyId },
        create: { companyId, balancePen: amount },
        update: { balancePen: { increment: amount } },
      });
      await tx.creditTransaction.create({
        data: {
          companyId,
          type: "VOUCHER",
          amountPen: amount,
          balanceAfterPen: wallet.balancePen,
          voucherId: voucher.id,
          note: `Vale ${voucher.code}`,
        },
      });
      return { kind: "CREDIT", amountPen: amount, balancePen: Number(wallet.balancePen) } as const;
    }

    // type === "PLAN"
    if (!voucher.planId) throw new AppError("Vale de paquete mal configurado", 409, { code: "VOUCHER_INVALID" });
    const months = voucher.months ?? 1;
    const now = new Date();
    const current = await tx.companySubscription.findUnique({ where: { companyId } });

    let expiresAt: Date;
    if (!current) {
      const created = await tx.companySubscription.create({
        data: {
          companyId,
          planId: voucher.planId,
          startsAt: now,
          expiresAt: addMonthsUtc(now, months),
          months,
          source: "VOUCHER",
          voucherId: voucher.id,
        },
      });
      expiresAt = created.expiresAt;
    } else if (current.planId === voucher.planId) {
      // Mismo plan (aunque esté vencido): EXTIENDE desde max(expiresAt, now).
      const base = current.expiresAt > now ? current.expiresAt : now;
      const updated = await tx.companySubscription.update({
        where: { companyId },
        data: {
          expiresAt: addMonthsUtc(base, months),
          months,
          source: "VOUCHER",
          voucherId: voucher.id,
          canceledAt: null,
        },
      });
      expiresAt = updated.expiresAt;
    } else {
      // Plan distinto: CAMBIA y reinicia el periodo (el tiempo restante se pierde).
      const updated = await tx.companySubscription.update({
        where: { companyId },
        data: {
          planId: voucher.planId,
          startsAt: now,
          expiresAt: addMonthsUtc(now, months),
          months,
          source: "VOUCHER",
          voucherId: voucher.id,
          canceledAt: null,
        },
      });
      expiresAt = updated.expiresAt;
    }

    return { kind: "PLAN", planName: voucher.plan?.name ?? "", months, expiresAt } as const;
  });

  invalidateEntitlements(companyId);
  return result;
}

// ---------------------------------------------------------------
// Cobro por lead extra: descuenta el precio del saldo de forma atómica.
// Retorna false si no hay saldo suficiente (el lead no se atiende).
// ---------------------------------------------------------------

export async function chargeLeadCredit(companyId: string, pricePen: number, customerPhone: string): Promise<boolean> {
  const price = round2(pricePen);
  if (price <= 0) return true;
  try {
    return await prisma.$transaction(async (tx) => {
      const res = await tx.companyWallet.updateMany({
        where: { companyId, balancePen: { gte: price } },
        data: { balancePen: { decrement: price } },
      });
      if (res.count === 0) return false;
      const wallet = await tx.companyWallet.findUnique({ where: { companyId } });
      await tx.creditTransaction.create({
        data: {
          companyId,
          type: "LEAD_CHARGE",
          amountPen: new Prisma.Decimal(-price),
          balanceAfterPen: wallet?.balancePen ?? new Prisma.Decimal(0),
          customerPhone,
          note: "Lead extra",
        },
      });
      return true;
    });
  } finally {
    invalidateEntitlements(companyId);
  }
}

// ---------------------------------------------------------------
// Gate de leads nuevos (lo llama el agente ANTES de crear el Customer).
// true = atender; false = descartar el inbound (sin persistir nada).
// ---------------------------------------------------------------

export async function gateNewLead(companyId: string, normalizedPhone: string): Promise<boolean> {
  const ent = await getEntitlements(companyId);
  if (ent.legacy) return true;

  // Modo créditos (plan vencido con saldo): TODO lead nuevo se cobra.
  if (ent.status === "CREDITS") {
    if (ent.extraLeadPricePen === null) return false;
    return chargeLeadCredit(companyId, ent.extraLeadPricePen, normalizedPhone);
  }

  if (ent.monthlyLeadLimit === null) return true;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { timezone: true },
  });
  const used = await countMonthlyLeads(companyId, company?.timezone ?? "America/Lima");
  if (used < ent.monthlyLeadLimit) return true;

  // Límite alcanzado: lead extra automático contra el saldo (si el plan lo permite).
  if (ent.extraLeadPricePen === null) return false;
  return chargeLeadCredit(companyId, ent.extraLeadPricePen, normalizedPhone);
}

// ---------------------------------------------------------------
// Planes públicos para la sección Precios del landing (sin auth).
// ---------------------------------------------------------------

export async function listPublicPlans() {
  const plans = await prisma.platformPlan.findMany({
    where: { isActive: true, isPublic: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    priceUsd: Number(p.priceUsd),
    pricePen: Number(p.pricePen),
    monthlyLeadLimit: p.monthlyLeadLimit,
    extraLeadPricePen: p.extraLeadPricePen === null ? null : Number(p.extraLeadPricePen),
    modules: p.modules,
    verticals: p.verticals,
    isHighlighted: p.isHighlighted,
  }));
}
