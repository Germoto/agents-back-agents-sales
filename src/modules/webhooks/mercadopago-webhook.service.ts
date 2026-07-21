/**
 * Webhook de Mercado Pago: POST /api/webhooks/mercadopago/:companyId
 *
 * MP notifica solo el id del pago; NUNCA confiamos en el payload: el backend
 * verifica el pago con GET /v1/payments/:id usando el Access Token del tenant
 * (imposible de falsificar sin el token). Si está aprobado:
 *  - registra el PaymentReceipt APROBADO (visible en el panel; idempotencia por
 *    unique(source, externalId)),
 *  - y dispara la entrega automática de la venta vía external_reference
 *    ({conversationId, productIds}) — mismo camino que el recheck de comprobantes.
 */

import { prisma } from "../../lib/prisma";
import { decryptCredential } from "../../lib/credentials-crypto";
import { mpGetPayment } from "../../lib/mercadopago-client";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { handleExternalPaymentApproved } from "../agent/agent.service";

interface MpReference {
  conversationId?: string;
  productIds?: string[];
}

export async function processMercadoPagoWebhook(
  companyId: string,
  body: unknown,
  query: Record<string, unknown>,
): Promise<{ ok: boolean; ignored?: boolean; duplicate?: boolean; receiptId?: string }> {
  const b = (body ?? {}) as Record<string, any>;
  const topic = String(b.type ?? b.topic ?? query.type ?? query.topic ?? "");
  const action = String(b.action ?? "");
  const paymentId = String(b.data?.id ?? query["data.id"] ?? query.id ?? "").trim();

  // Solo nos interesan notificaciones de pagos con id.
  if (!paymentId) return { ok: true, ignored: true };
  if (topic && topic !== "payment" && !action.startsWith("payment.")) return { ok: true, ignored: true };

  const pc = await prisma.paymentConfig.findUnique({ where: { companyId } });
  const token = pc?.mpAccessToken ? decryptCredential(pc.mpAccessToken) : "";
  if (!token) return { ok: true, ignored: true };

  let payment;
  try {
    payment = await mpGetPayment(token, paymentId);
  } catch (err) {
    console.warn(
      `[mp-webhook] no se pudo verificar el pago ${paymentId} (company=${companyId}):`,
      err instanceof Error ? err.message : err,
    );
    return { ok: true, ignored: true };
  }

  if (payment.status !== "approved") return { ok: true, ignored: true };

  const source = "mercadopago";
  const externalId = String(payment.id);

  let ref: MpReference = {};
  try {
    ref = JSON.parse(payment.external_reference ?? "{}") as MpReference;
  } catch {
    ref = {};
  }

  const convo = ref.conversationId
    ? await prisma.conversation.findFirst({
        where: { id: ref.conversationId, companyId },
        select: { customerId: true },
      })
    : null;

  const payerName =
    [payment.payer?.first_name, payment.payer?.last_name].filter(Boolean).join(" ").trim() ||
    payment.payer?.email ||
    null;
  const amountText = `S/ ${Number(payment.transaction_amount ?? 0).toFixed(2)}`;

  // Idempotencia: unique(source, externalId) en PaymentReceipt. MP reintenta las
  // notificaciones; solo la primera crea el receipt y dispara la entrega.
  let receiptId: string;
  try {
    const receipt = await prisma.paymentReceipt.create({
      data: {
        companyId,
        customerId: convo?.customerId ?? null,
        productIds: ref.productIds ?? [],
        amountExpected: String(payment.transaction_amount ?? 0),
        amountPaid: String(payment.transaction_amount ?? 0),
        currency: payment.currency_id ?? "PEN",
        status: "APROBADO",
        source,
        externalId,
        payerName,
        paymentSource: "mercadopago",
        occurredAt: payment.date_approved ? new Date(payment.date_approved) : new Date(),
        validatedAt: new Date(),
        validationMode: "AUTO",
        validationNote: "Pago confirmado por Mercado Pago (webhook + verificación API)",
        metadata: { conversationId: ref.conversationId ?? null, mpPaymentId: externalId },
      },
    });
    receiptId = receipt.id;
  } catch (err) {
    // P2002 = ya procesado (reintento de MP)
    if ((err as { code?: string })?.code === "P2002") return { ok: true, duplicate: true };
    throw err;
  }

  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_NEW, { receiptId, source });

  // Entrega automática fuera del request del webhook (best-effort, no bloquea el 200).
  if (ref.conversationId) {
    void handleExternalPaymentApproved({
      companyId,
      conversationId: ref.conversationId,
      productIds: ref.productIds ?? [],
      amountText,
      payerName,
      provider: "Mercado Pago",
    });
  }

  return { ok: true, receiptId };
}
