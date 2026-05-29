import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { smsTools } from "../../lib/smstools-client";
import { getAdapter } from "./adapters";
import { applyReceiptApproval } from "../receipts/receipts.service";

/**
 * Resultado devuelto al controller tras procesar un webhook entrante.
 */
export interface ProcessWebhookResult {
  eventId: string;
  status: "PROCESSED" | "DUPLICATE" | "FAILED";
  receiptId?: string;
  matched: boolean;
}

/**
 * Procesa un webhook entrante de pago:
 * 1. Verifica idempotencia (source + externalId).
 * 2. Normaliza el payload via adapter.
 * 3. Intenta hacer match con un DigitalSale pendiente.
 * 4. Crea PaymentReceipt (APROBADO si autoApprove + match único, sino PENDIENTE).
 * 5. Cascade a DigitalSale si corresponde.
 * 6. Notifica al notificationPhone via WhatsApp.
 * 7. Actualiza lastUsedAt del endpoint.
 */
export async function processWebhook(
  companyId: string,
  endpointId: string,
  source: string,
  rawPayload: unknown,
): Promise<ProcessWebhookResult> {
  // 1. Obtener el adapter
  const adapter = getAdapter(source);
  if (!adapter) {
    throw new AppError(`No hay adapter para el source: ${source}`, 422);
  }

  // 2. Normalizar payload
  const payment = adapter.normalize(rawPayload);

  // 3. Idempotencia: verificar si ya fue procesado
  const existing = await prisma.webhookEvent.findUnique({
    where: { source_externalId: { source, externalId: payment.externalId } },
  });
  if (existing) {
    return {
      eventId: existing.id,
      status: "DUPLICATE",
      receiptId: existing.receiptId ?? undefined,
      matched: false,
    };
  }

  // 4. Obtener endpoint para autoApprove
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) throw new AppError("Endpoint no encontrado", 404);

  // 5. Buscar DigitalSale matcheable
  //    Criterios: misma company, status=ESPERANDO_PAGO, amountExpected == amount,
  //    creada en las últimas 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const candidates = await prisma.digitalSale.findMany({
    where: {
      companyId,
      status: "ESPERANDO_PAGO",
      amountExpected: payment.amount,
      createdAt: { gte: since },
    },
    include: { customer: true },
    orderBy: { createdAt: "desc" },
  });

  const matchedSale = candidates.length === 1 ? candidates[0] : null;

  // 6. Determinar estado del comprobante
  const autoApprove = endpoint.autoApprove && matchedSale !== null;
  const receiptStatus = autoApprove ? "APROBADO" : "PENDIENTE";

  // 7. Necesitamos customerId y productId para crear el PaymentReceipt
  //    Si hay match usamos los del DigitalSale; sino buscamos o creamos customer "desconocido"
  let customerId: string;
  let productId: string;
  let digitalSaleId: string | null = null;

  if (matchedSale) {
    customerId = matchedSale.customerId;
    productId = matchedSale.productId;
    digitalSaleId = matchedSale.id;
  } else {
    // Buscar customer por nombre (best-effort) o crear uno genérico
    const existingCustomer = await prisma.customer.findFirst({
      where: {
        companyId,
        name: { equals: payment.payerName, mode: "insensitive" },
      },
    });

    if (existingCustomer) {
      customerId = existingCustomer.id;
      // Intentar encontrar su última venta pendiente
      const lastSale = await prisma.digitalSale.findFirst({
        where: { companyId, customerId, status: "ESPERANDO_PAGO" },
        orderBy: { createdAt: "desc" },
      });
      productId = lastSale?.productId ?? await getFirstProductId(companyId);
      digitalSaleId = lastSale?.id ?? null;
    } else {
      // Crear customer temporal con nombre del pagador
      const newCustomer = await prisma.customer.create({
        data: {
          companyId,
          phone: `webhook_${payment.externalId.slice(0, 12)}`,
          name: payment.payerName || "Pagador desconocido",
          status: "activo",
          lastInteractionAt: new Date(),
          metadata: { origin: "webhook", source },
        },
      });
      customerId = newCustomer.id;
      productId = await getFirstProductId(companyId);
    }
  }

  // 8. Crear receipt + evento en transacción
  let receiptId: string;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const receipt = await tx.paymentReceipt.create({
        data: {
          companyId,
          customerId,
          productId,
          digitalSaleId,
          amountExpected: payment.amount,
          status: receiptStatus as any,
          source,
          externalId: payment.externalId,
        },
      });

      if (autoApprove && digitalSaleId) {
        await applyReceiptApproval(tx, receipt.id, digitalSaleId);
      }

      const event = await tx.webhookEvent.create({
        data: {
          endpointId,
          companyId,
          source,
          externalId: payment.externalId,
          payload: rawPayload as any,
          status: "PROCESSED",
          receiptId: receipt.id,
        },
      });

      return { receipt, event };
    });

    receiptId = result.receipt.id;

    // 9. Actualizar lastUsedAt del endpoint (fuera de la tx, no crítico)
    prisma.webhookEndpoint
      .update({ where: { id: endpointId }, data: { lastUsedAt: new Date() } })
      .catch(() => {/* best-effort */});

    // 10. Notificar al notificationPhone via WhatsApp (best-effort, no bloquea la respuesta)
    notifyPaymentReceived(companyId, payment.payerName, payment.amount, source, matchedSale !== null).catch(
      () => {/* silenciar errores de notificación */},
    );

    return {
      eventId: result.event.id,
      status: "PROCESSED",
      receiptId,
      matched: matchedSale !== null,
    };
  } catch (err: any) {
    // Si es violación de unique (carrera de idempotencia), tratar como DUPLICATE
    if (err.code === "P2002") {
      const dup = await prisma.webhookEvent.findUnique({
        where: { source_externalId: { source, externalId: payment.externalId } },
      });
      return {
        eventId: dup?.id ?? "",
        status: "DUPLICATE",
        receiptId: dup?.receiptId ?? undefined,
        matched: false,
      };
    }

    // Registrar el fallo
    await prisma.webhookEvent.create({
      data: {
        endpointId,
        companyId,
        source,
        externalId: payment.externalId,
        payload: rawPayload as any,
        status: "FAILED",
        error: err.message ?? String(err),
      },
    }).catch(() => {/* best-effort */});

    throw err;
  }
}

/**
 * Envía notificación WhatsApp al notificationPhone de la company cuando
 * llega un pago por webhook.
 */
async function notifyPaymentReceived(
  companyId: string,
  payerName: string,
  amount: string,
  source: string,
  matched: boolean,
) {
  const [paymentConfig, whatsappConfig] = await Promise.all([
    prisma.paymentConfig.findUnique({
      where: { companyId },
      select: { notificationPhone: true },
    }),
    prisma.whatsappConfig.findFirst({
      where: { companyId, isActive: true },
      select: { apiUrl: true, secret: true, account: true },
    }),
  ]);

  if (!paymentConfig?.notificationPhone || !whatsappConfig?.account) return;

  const sourceLabel = source === "validpay" ? "ValidPay (Yape/Plin)" : source;
  const matchInfo = matched
    ? "✅ Vinculado a una venta pendiente automáticamente."
    : "⚠️ No se encontró venta pendiente. Revisa /comprobantes.";

  const message =
    `💰 *Pago recibido via ${sourceLabel}*\n` +
    `Pagador: ${payerName}\n` +
    `Monto: S/ ${amount}\n` +
    matchInfo;

  await smsTools.sendMessage(
    { apiUrl: whatsappConfig.apiUrl, secret: whatsappConfig.secret },
    whatsappConfig.account,
    paymentConfig.notificationPhone,
    message,
  );
}

/**
 * Helper: obtiene el ID del primer producto activo de la company como fallback.
 */
async function getFirstProductId(companyId: string): Promise<string> {
  const product = await prisma.product.findFirst({
    where: { companyId, active: true },
    select: { id: true },
    orderBy: { sortOrder: "asc" },
  });
  if (!product) throw new AppError("La company no tiene productos registrados", 422);
  return product.id;
}
