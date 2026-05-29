import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { getAdapter } from "./adapters";

/**
 * Resultado devuelto al controller tras procesar un webhook entrante.
 */
export interface ProcessWebhookResult {
  eventId: string;
  status: "PROCESSED" | "DUPLICATE" | "FAILED";
  receiptId?: string;
}

/**
 * Procesa un webhook entrante de pago.
 *
 * Diseño: el webhook SOLO registra el comprobante crudo (sin asociar producto
 * ni cliente, sin notificar). Quien valide/matchee y confirme con el cliente
 * es n8n vía /api/public/payments/*.
 *
 * Pasos:
 * 1. Adapter normaliza el payload del origen.
 * 2. Idempotencia por (source, externalId).
 * 3. Crea PaymentReceipt huérfano (status=PENDIENTE, sin product/customer).
 * 4. Registra WebhookEvent (PROCESSED / DUPLICATE / FAILED).
 * 5. Actualiza lastUsedAt del endpoint.
 */
export async function processWebhook(
  companyId: string,
  endpointId: string,
  source: string,
  rawPayload: unknown,
): Promise<ProcessWebhookResult> {
  const adapter = getAdapter(source);
  if (!adapter) {
    throw new AppError(`No hay adapter para el source: ${source}`, 422);
  }

  const payment = adapter.normalize(rawPayload);

  // Idempotencia
  const existing = await prisma.webhookEvent.findUnique({
    where: { source_externalId: { source, externalId: payment.externalId } },
  });
  if (existing) {
    return {
      eventId: existing.id,
      status: "DUPLICATE",
      receiptId: existing.receiptId ?? undefined,
    };
  }

  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) throw new AppError("Endpoint no encontrado", 404);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const receipt = await tx.paymentReceipt.create({
        data: {
          companyId,
          customerId: null,
          productId: null,
          digitalSaleId: null,
          amountExpected: payment.amount,
          status: "PENDIENTE",
          source,
          externalId: payment.externalId,
          payerName: payment.payerName || null,
          paymentSource: payment.paymentSource ?? null,
          occurredAt: payment.occurredAt ?? null,
        },
      });

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

    // best-effort: marcar último uso del endpoint
    prisma.webhookEndpoint
      .update({ where: { id: endpointId }, data: { lastUsedAt: new Date() } })
      .catch(() => {/* silent */});

    return {
      eventId: result.event.id,
      status: "PROCESSED",
      receiptId: result.receipt.id,
    };
  } catch (err: any) {
    // Carrera de idempotencia
    if (err.code === "P2002") {
      const dup = await prisma.webhookEvent.findUnique({
        where: { source_externalId: { source, externalId: payment.externalId } },
      });
      return {
        eventId: dup?.id ?? "",
        status: "DUPLICATE",
        receiptId: dup?.receiptId ?? undefined,
      };
    }

    // Registrar el fallo (best-effort)
    await prisma.webhookEvent
      .create({
        data: {
          endpointId,
          companyId,
          source,
          externalId: payment.externalId,
          payload: rawPayload as any,
          status: "FAILED",
          error: err.message ?? String(err),
        },
      })
      .catch(() => {/* silent */});

    throw err;
  }
}
