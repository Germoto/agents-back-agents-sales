/**
 * Checkout de Mercado Pago a nivel PLATAFORMA: el tenant paga su suscripción
 * (nueva / renovación / cambio de plan, 1 o 12 meses) o recarga créditos desde
 * Mi plan, con la cuenta MP del dueño de FlowApp. El webhook de plataforma
 * aplica la compra automáticamente al aprobarse (idempotente).
 *
 * Semántica de aplicación = la del canje de vales (redeemVoucher): mismo plan
 * → EXTIENDE desde max(vencimiento, hoy); plan distinto o sin suscripción →
 * periodo nuevo desde hoy.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { mpCreatePreference, mpGetPayment } from "../../lib/mercadopago-client";
import { getPlatformMpBilling } from "../platform-config/platform-config.service";
import { addMonthsUtc } from "./billing.service";
import { invalidateEntitlements } from "./entitlements";

export type MpCheckoutInput =
  | { kind: "PLAN"; planId: string; cycle: "monthly" | "yearly" }
  | { kind: "CREDITS"; amountPen: number };

// ---------------------------------------------------------------------------
// Checkout (lo llama el tenant desde Mi plan)
// ---------------------------------------------------------------------------

export async function createMpCheckout(
  companyId: string,
  input: MpCheckoutInput,
  origin: string | null,
): Promise<{ initPoint: string; purchaseId: string }> {
  const { enabled, accessToken } = await getPlatformMpBilling();
  if (!enabled || !accessToken) {
    throw new AppError("El pago online no está disponible por el momento", 503);
  }

  let title: string;
  let amountPen: number;
  let planId: string | null = null;
  let months: number | null = null;
  let creditAmountPen: number | null = null;

  if (input.kind === "PLAN") {
    const [plan, sub] = await Promise.all([
      prisma.platformPlan.findUnique({ where: { id: input.planId } }),
      prisma.companySubscription.findUnique({ where: { companyId }, select: { planId: true } }),
    ]);
    // Planes públicos, o el plan ACTUAL del tenant aunque sea oculto (renovación
    // de planes personalizados/snapshot).
    if (!plan || !plan.isActive || (!plan.isPublic && plan.id !== sub?.planId)) {
      throw new AppError("Paquete no disponible", 404);
    }
    if (input.cycle === "yearly") {
      months = 12;
      amountPen =
        plan.pricePenYearly !== null ? Number(plan.pricePenYearly) : Number(plan.pricePen) * 12;
      title = `FlowApp — Plan ${plan.name} (12 meses)`;
    } else {
      months = 1;
      amountPen = Number(plan.pricePen);
      title = `FlowApp — Plan ${plan.name} (1 mes)`;
    }
    if (!(amountPen > 0)) throw new AppError("Este paquete no tiene precio configurado en S/", 400);
    planId = plan.id;
  } else {
    creditAmountPen = Math.round(input.amountPen * 100) / 100;
    amountPen = creditAmountPen;
    title = `FlowApp — Recarga de créditos (S/ ${creditAmountPen.toFixed(2)})`;
  }

  const purchase = await prisma.platformPayment.create({
    data: {
      companyId,
      kind: input.kind,
      planId,
      months,
      amountPen,
      creditAmountPen,
    },
    select: { id: true },
  });

  const base = (origin || env.PUBLIC_BASE_URL).replace(/\/$/, "");
  const pref = await mpCreatePreference(accessToken, {
    title,
    amount: amountPen,
    externalReference: JSON.stringify({ platformPaymentId: purchase.id }),
    notificationUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/platform/mercadopago`,
    backUrls: {
      success: `${base}/mi-plan?pago=exito`,
      failure: `${base}/mi-plan?pago=error`,
      pending: `${base}/mi-plan?pago=pendiente`,
    },
    autoReturn: true,
  });

  await prisma.platformPayment.update({
    where: { id: purchase.id },
    data: { mpPreferenceId: pref.id },
  });

  return { initPoint: pref.init_point, purchaseId: purchase.id };
}

/** Historial de compras del tenant para Mi plan. */
export async function listMyPurchases(companyId: string) {
  const rows = await prisma.platformPayment.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const planIds = [...new Set(rows.map((r) => r.planId).filter(Boolean))] as string[];
  const plans = planIds.length
    ? await prisma.platformPlan.findMany({ where: { id: { in: planIds } }, select: { id: true, name: true } })
    : [];
  const planName = new Map(plans.map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    planName: r.planId ? planName.get(r.planId) ?? null : null,
    months: r.months,
    amountPen: Number(r.amountPen),
    status: r.status,
    createdAt: r.createdAt,
    paidAt: r.paidAt,
  }));
}

// ---------------------------------------------------------------------------
// Webhook de plataforma (aplica la compra al aprobarse)
// ---------------------------------------------------------------------------

async function applyPurchase(purchase: {
  id: string;
  companyId: string;
  kind: string;
  planId: string | null;
  months: number | null;
  creditAmountPen: Prisma.Decimal | null;
}): Promise<void> {
  const now = new Date();
  if (purchase.kind === "PLAN" && purchase.planId && purchase.months) {
    const months = purchase.months;
    const sub = await prisma.companySubscription.findUnique({ where: { companyId: purchase.companyId } });
    if (!sub) {
      await prisma.companySubscription.create({
        data: {
          companyId: purchase.companyId,
          planId: purchase.planId,
          startsAt: now,
          expiresAt: addMonthsUtc(now, months),
          months,
          source: "MERCADOPAGO",
        },
      });
    } else if (sub.planId === purchase.planId) {
      // Renovación del mismo plan: extiende desde el vencimiento (o desde hoy).
      const base = sub.expiresAt > now ? sub.expiresAt : now;
      await prisma.companySubscription.update({
        where: { companyId: purchase.companyId },
        data: { expiresAt: addMonthsUtc(base, months), months, source: "MERCADOPAGO", canceledAt: null },
      });
    } else {
      // Cambio de plan: periodo nuevo desde hoy.
      await prisma.companySubscription.update({
        where: { companyId: purchase.companyId },
        data: {
          planId: purchase.planId,
          startsAt: now,
          expiresAt: addMonthsUtc(now, months),
          months,
          source: "MERCADOPAGO",
          canceledAt: null,
        },
      });
    }
  } else if (purchase.kind === "CREDITS" && purchase.creditAmountPen) {
    const amount = Number(purchase.creditAmountPen);
    const wallet = await prisma.companyWallet.upsert({
      where: { companyId: purchase.companyId },
      update: { balancePen: { increment: amount } },
      create: { companyId: purchase.companyId, balancePen: amount },
    });
    await prisma.creditTransaction.create({
      data: {
        companyId: purchase.companyId,
        type: "MP_TOPUP",
        amountPen: amount,
        balanceAfterPen: wallet.balancePen,
        note: `Recarga con Mercado Pago`,
      },
    });
  }
  invalidateEntitlements(purchase.companyId);
}

export async function processPlatformMpWebhook(
  body: unknown,
  query: Record<string, unknown>,
): Promise<{ ok: boolean; ignored?: boolean; duplicate?: boolean; applied?: boolean }> {
  const b = (body ?? {}) as Record<string, any>;
  const topic = String(b.type ?? b.topic ?? query.type ?? query.topic ?? "");
  const action = String(b.action ?? "");
  const paymentId = String(b.data?.id ?? query["data.id"] ?? query.id ?? "").trim();

  if (!paymentId) return { ok: true, ignored: true };
  if (topic && topic !== "payment" && !action.startsWith("payment.")) return { ok: true, ignored: true };

  const { accessToken } = await getPlatformMpBilling();
  if (!accessToken) return { ok: true, ignored: true };

  let payment;
  try {
    payment = await mpGetPayment(accessToken, paymentId);
  } catch (err) {
    console.warn(`[platform-mp] no se pudo verificar el pago ${paymentId}:`, err instanceof Error ? err.message : err);
    return { ok: true, ignored: true };
  }
  if (payment.status !== "approved") return { ok: true, ignored: true };

  let purchaseId = "";
  try {
    purchaseId = String((JSON.parse(payment.external_reference ?? "{}") as { platformPaymentId?: string }).platformPaymentId ?? "");
  } catch {
    /* ref ajena */
  }
  if (!purchaseId) return { ok: true, ignored: true };

  const purchase = await prisma.platformPayment.findUnique({ where: { id: purchaseId } });
  if (!purchase) return { ok: true, ignored: true };

  // El monto verificado contra la API debe coincidir con lo que se cotizó.
  if (Math.abs(payment.transaction_amount - Number(purchase.amountPen)) > 0.01) {
    console.error(
      `[platform-mp] monto no coincide (purchase=${purchaseId} esperado=${purchase.amountPen} pagado=${payment.transaction_amount}) — NO se aplica`,
    );
    return { ok: true, ignored: true };
  }

  // Claim atómico (idempotencia): solo el primer webhook aplica.
  const claimed = await prisma.platformPayment.updateMany({
    where: { id: purchaseId, status: "PENDING" },
    data: { status: "APPROVED", mpPaymentId: String(payment.id), paidAt: new Date() },
  });
  if (claimed.count === 0) return { ok: true, duplicate: true };

  try {
    await applyPurchase(purchase);
    console.log(`[platform-mp] compra aplicada: ${purchase.kind} company=${purchase.companyId} (S/ ${purchase.amountPen})`);
    return { ok: true, applied: true };
  } catch (err) {
    // Revertir el claim para que el reintento de MP vuelva a aplicar.
    console.error(`[platform-mp] fallo aplicando compra ${purchaseId}:`, err instanceof Error ? err.message : err);
    await prisma.platformPayment
      .updateMany({ where: { id: purchaseId }, data: { status: "PENDING", mpPaymentId: null, paidAt: null } })
      .catch(() => undefined);
    return { ok: false };
  }
}
