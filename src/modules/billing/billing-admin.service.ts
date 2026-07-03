import { Prisma, type BusinessVertical, type PlanModule, type VoucherType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { generateVoucherCode } from "../../lib/codes";
import { addMonthsUtc } from "./billing.service";
import { deriveBillingState, invalidateEntitlements } from "./entitlements";

// ============================================================
// Administración de la monetización SaaS (consola superadmin):
// CRUD de paquetes, suscripciones de tenants, lotes de vales y créditos.
// ============================================================

// ---------------------------------------------------------------
// Paquetes (PlatformPlan)
// ---------------------------------------------------------------

export type PlanInput = {
  name: string;
  description?: string | null;
  priceUsd: number;
  pricePen: number;
  monthlyLeadLimit?: number | null;
  extraLeadPricePen?: number | null;
  verticals: BusinessVertical[];
  modules: PlanModule[];
  isPublic: boolean;
  isHighlighted: boolean;
  sortOrder: number;
  isActive: boolean;
};

function mapPlan(plan: Prisma.PlatformPlanGetPayload<{ include: { _count: { select: { subscriptions: true; vouchers: true } } } }>) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    priceUsd: Number(plan.priceUsd),
    pricePen: Number(plan.pricePen),
    monthlyLeadLimit: plan.monthlyLeadLimit,
    extraLeadPricePen: plan.extraLeadPricePen === null ? null : Number(plan.extraLeadPricePen),
    verticals: plan.verticals,
    modules: plan.modules,
    isPublic: plan.isPublic,
    isHighlighted: plan.isHighlighted,
    sortOrder: plan.sortOrder,
    isActive: plan.isActive,
    subscriptionCount: plan._count.subscriptions,
    voucherCount: plan._count.vouchers,
    createdAt: plan.createdAt,
  };
}

const PLAN_INCLUDE = { _count: { select: { subscriptions: true, vouchers: true } } } as const;

export async function listPlans() {
  const plans = await prisma.platformPlan.findMany({
    include: PLAN_INCLUDE,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return plans.map(mapPlan);
}

export async function createPlan(input: PlanInput) {
  const plan = await prisma.platformPlan.create({
    data: { ...input },
    include: PLAN_INCLUDE,
  });
  return mapPlan(plan);
}

export async function updatePlan(id: string, input: PlanInput) {
  const existing = await prisma.platformPlan.findUnique({ where: { id } });
  if (!existing) throw new AppError("Paquete no encontrado", 404);
  const plan = await prisma.platformPlan.update({
    where: { id },
    data: { ...input },
    include: PLAN_INCLUDE,
  });
  // El plan define módulos/límites de sus suscriptores: refrescar sus cachés.
  const subs = await prisma.companySubscription.findMany({ where: { planId: id }, select: { companyId: true } });
  for (const s of subs) invalidateEntitlements(s.companyId);
  return mapPlan(plan);
}

export async function deletePlan(id: string) {
  const counts = await prisma.platformPlan.findUnique({ where: { id }, include: PLAN_INCLUDE });
  if (!counts) throw new AppError("Paquete no encontrado", 404);
  if (counts._count.subscriptions > 0 || counts._count.vouchers > 0) {
    throw new AppError(
      "El paquete tiene suscripciones o vales asociados. Desactívalo en lugar de eliminarlo.",
      409,
      { code: "PLAN_IN_USE" },
    );
  }
  await prisma.platformPlan.delete({ where: { id } });
}

// ---------------------------------------------------------------
// Suscripciones de tenants (CompanySubscription)
// ---------------------------------------------------------------

const SUB_INCLUDE = {
  plan: true,
  company: {
    select: {
      id: true,
      name: true,
      slug: true,
      users: {
        where: { role: "ADMIN" as const, isActive: true },
        select: { name: true, phone: true },
        take: 1,
      },
    },
  },
} as const;

type SubRow = Prisma.CompanySubscriptionGetPayload<{ include: typeof SUB_INCLUDE }>;

function mapSubscription(sub: SubRow, balancePen: number) {
  const { status, graceEndsAt } = deriveBillingState(sub, balancePen);
  return {
    id: sub.id,
    companyId: sub.companyId,
    companyName: sub.company.name,
    companySlug: sub.company.slug,
    adminName: sub.company.users[0]?.name ?? null,
    adminPhone: sub.company.users[0]?.phone ?? null,
    planId: sub.planId,
    planName: sub.plan.name,
    priceUsd: Number(sub.plan.priceUsd),
    pricePen: Number(sub.plan.pricePen),
    startsAt: sub.startsAt,
    expiresAt: sub.expiresAt,
    graceEndsAt,
    months: sub.months,
    source: sub.source,
    canceledAt: sub.canceledAt,
    status,
    balancePen,
  };
}

async function walletBalances(companyIds: string[]): Promise<Map<string, number>> {
  if (companyIds.length === 0) return new Map();
  const wallets = await prisma.companyWallet.findMany({ where: { companyId: { in: companyIds } } });
  return new Map(wallets.map((w) => [w.companyId, Number(w.balancePen)]));
}

export async function listSubscriptions() {
  const subs = await prisma.companySubscription.findMany({
    include: SUB_INCLUDE,
    orderBy: { expiresAt: "asc" },
  });
  const balances = await walletBalances(subs.map((s) => s.companyId));
  return subs.map((s) => mapSubscription(s, balances.get(s.companyId) ?? 0));
}

/** Asigna (o reasigna) un paquete a una empresa: periodo nuevo desde hoy. */
export async function assignSubscription(companyId: string, planId: string, months: number) {
  const [company, plan] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }),
    prisma.platformPlan.findUnique({ where: { id: planId } }),
  ]);
  if (!company) throw new AppError("Empresa no encontrada", 404);
  if (!plan || !plan.isActive) throw new AppError("Paquete no encontrado o inactivo", 404);

  const now = new Date();
  const expiresAt = addMonthsUtc(now, months);
  const sub = await prisma.companySubscription.upsert({
    where: { companyId },
    create: { companyId, planId, startsAt: now, expiresAt, months, source: "SUPERADMIN" },
    update: { planId, startsAt: now, expiresAt, months, source: "SUPERADMIN", canceledAt: null },
    include: SUB_INCLUDE,
  });
  invalidateEntitlements(companyId);
  const balances = await walletBalances([companyId]);
  return mapSubscription(sub, balances.get(companyId) ?? 0);
}

export async function extendSubscription(id: string, months: number) {
  const current = await prisma.companySubscription.findUnique({ where: { id } });
  if (!current) throw new AppError("Suscripción no encontrada", 404);
  const now = new Date();
  const base = current.expiresAt > now ? current.expiresAt : now;
  const sub = await prisma.companySubscription.update({
    where: { id },
    data: { expiresAt: addMonthsUtc(base, months), canceledAt: null },
    include: SUB_INCLUDE,
  });
  invalidateEntitlements(sub.companyId);
  const balances = await walletBalances([sub.companyId]);
  return mapSubscription(sub, balances.get(sub.companyId) ?? 0);
}

export async function cancelSubscription(id: string) {
  const current = await prisma.companySubscription.findUnique({ where: { id } });
  if (!current) throw new AppError("Suscripción no encontrada", 404);
  const sub = await prisma.companySubscription.update({
    where: { id },
    data: { canceledAt: new Date() },
    include: SUB_INCLUDE,
  });
  invalidateEntitlements(sub.companyId);
  const balances = await walletBalances([sub.companyId]);
  return mapSubscription(sub, balances.get(sub.companyId) ?? 0);
}

/** Elimina la suscripción: la empresa vuelve a LEGACY (acceso libre sin límites). */
export async function deleteSubscription(id: string) {
  const current = await prisma.companySubscription.findUnique({ where: { id } });
  if (!current) throw new AppError("Suscripción no encontrada", 404);
  await prisma.companySubscription.delete({ where: { id } });
  invalidateEntitlements(current.companyId);
}

// ---------------------------------------------------------------
// Vales (Voucher) — generación por lote
// ---------------------------------------------------------------

export type VoucherBatchInput = {
  name: string;
  count: number;
  type: VoucherType;
  planId?: string;
  months?: number;
  creditAmountPen?: number;
};

const VOUCHER_INCLUDE = {
  plan: { select: { name: true } },
  redeemedByCompany: { select: { name: true, slug: true } },
} as const;

function mapVoucher(v: Prisma.VoucherGetPayload<{ include: typeof VOUCHER_INCLUDE }>) {
  return {
    id: v.id,
    code: v.code,
    name: v.name,
    type: v.type,
    planId: v.planId,
    planName: v.plan?.name ?? null,
    months: v.months,
    creditAmountPen: v.creditAmountPen === null ? null : Number(v.creditAmountPen),
    redeemedAt: v.redeemedAt,
    redeemedByCompany: v.redeemedByCompany
      ? { name: v.redeemedByCompany.name, slug: v.redeemedByCompany.slug }
      : null,
    createdAt: v.createdAt,
  };
}

export async function listVouchers(status?: "available" | "redeemed") {
  const vouchers = await prisma.voucher.findMany({
    where:
      status === "available"
        ? { redeemedAt: null }
        : status === "redeemed"
          ? { redeemedAt: { not: null } }
          : undefined,
    include: VOUCHER_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return vouchers.map(mapVoucher);
}

export async function createVoucherBatch(input: VoucherBatchInput) {
  if (input.type === "PLAN") {
    if (!input.planId || !input.months) {
      throw new AppError("Un vale de paquete requiere paquete y meses", 422);
    }
    const plan = await prisma.platformPlan.findUnique({ where: { id: input.planId } });
    if (!plan) throw new AppError("Paquete no encontrado", 404);
  } else if (!input.creditAmountPen || input.creditAmountPen <= 0) {
    throw new AppError("Un vale de créditos requiere un monto en S/ mayor a 0", 422);
  }

  const baseData = {
    type: input.type,
    planId: input.type === "PLAN" ? input.planId! : null,
    months: input.type === "PLAN" ? input.months! : null,
    creditAmountPen: input.type === "CREDIT" ? input.creditAmountPen! : null,
  };

  // Inserta fila por fila con reintento ante colisión de código (P2002).
  // Con alfabeto de 31^8 por prefijo la colisión es teórica, pero el unique
  // de la BD es la única fuente de verdad.
  const ids = await prisma.$transaction(async (tx) => {
    const createdIds: string[] = [];
    for (let i = 0; i < input.count; i++) {
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        try {
          const row = await tx.voucher.create({
            data: {
              ...baseData,
              code: generateVoucherCode(input.name),
              name: input.count > 1 ? `${input.name} #${i + 1}` : input.name,
            },
          });
          createdIds.push(row.id);
          inserted = true;
        } catch (err) {
          const isCodeCollision =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
          if (!isCodeCollision) throw err;
        }
      }
      if (!inserted) {
        throw new AppError("No se pudieron generar todos los códigos, intenta de nuevo", 500);
      }
    }
    return createdIds;
  });

  const vouchers = await prisma.voucher.findMany({
    where: { id: { in: ids } },
    include: VOUCHER_INCLUDE,
    orderBy: { name: "asc" },
  });
  return vouchers.map(mapVoucher);
}

export async function deleteVoucher(id: string) {
  const voucher = await prisma.voucher.findUnique({ where: { id } });
  if (!voucher) throw new AppError("Vale no encontrado", 404);
  if (voucher.redeemedAt) {
    throw new AppError("No se puede eliminar un vale ya canjeado", 409, { code: "VOUCHER_REDEEMED" });
  }
  await prisma.voucher.delete({ where: { id } });
}

// ---------------------------------------------------------------
// Créditos — recarga/ajuste manual del superadmin
// ---------------------------------------------------------------

export async function adjustCredits(companyId: string, amountPen: number, note?: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) throw new AppError("Empresa no encontrada", 404);
  if (amountPen === 0) throw new AppError("El monto no puede ser 0", 422);

  const result = await prisma.$transaction(async (tx) => {
    let balanceAfter: Prisma.Decimal;
    if (amountPen > 0) {
      const wallet = await tx.companyWallet.upsert({
        where: { companyId },
        create: { companyId, balancePen: amountPen },
        update: { balancePen: { increment: amountPen } },
      });
      balanceAfter = wallet.balancePen;
    } else {
      // Ajuste negativo: nunca dejar el saldo por debajo de 0.
      const res = await tx.companyWallet.updateMany({
        where: { companyId, balancePen: { gte: Math.abs(amountPen) } },
        data: { balancePen: { decrement: Math.abs(amountPen) } },
      });
      if (res.count === 0) {
        throw new AppError("Saldo insuficiente para aplicar el ajuste negativo", 409, {
          code: "INSUFFICIENT_BALANCE",
        });
      }
      const wallet = await tx.companyWallet.findUnique({ where: { companyId } });
      balanceAfter = wallet?.balancePen ?? new Prisma.Decimal(0);
    }
    await tx.creditTransaction.create({
      data: {
        companyId,
        type: "ADMIN_ADJUST",
        amountPen,
        balanceAfterPen: balanceAfter,
        note: note ?? null,
      },
    });
    return Number(balanceAfter);
  });

  invalidateEntitlements(companyId);
  return { companyId, balancePen: result };
}

export async function listCompanyCreditTransactions(companyId: string, limit = 100) {
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
