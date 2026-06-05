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

  // Si el evento es "payment.validated", actualizamos el receipt existente en vez de crear uno nuevo.
  const isValidated = payment.event === "payment.validated";

  try {
    const result = await prisma.$transaction(async (tx) => {
      let receipt;

      if (isValidated) {
        // Buscar el receipt existente por (source, externalId)
        const existing = await tx.paymentReceipt.findUnique({
          where: { source_externalId: { source, externalId: payment.externalId } },
        });

        if (existing) {
          // Actualizar a APROBADO si está en estado PENDIENTE o EN_REVISION
          if (existing.status === "PENDIENTE" || existing.status === "EN_REVISION") {
            receipt = await tx.paymentReceipt.update({
              where: { id: existing.id },
              data: {
                status: "APROBADO",
                validatedAt: new Date(),
                validationMode: "AUTO",
                validationNote: "Validado automáticamente por ValidPay",
              },
            });
          } else {
            // Ya estaba APROBADO o RECHAZADO — no tocamos
            receipt = existing;
          }
        } else {
          // Nunca recibimos el payment.received, crear directamente como APROBADO
          receipt = await tx.paymentReceipt.create({
            data: {
              companyId,
              customerId: null,
              productId: null,
              digitalSaleId: null,
              amountExpected: payment.amount,
              amountPaid: payment.amount,
              currency: payment.currency ?? "PEN",
              status: "APROBADO",
              source,
              externalId: payment.externalId,
              payerName: payment.payerName || null,
              paymentSource: payment.paymentSource ?? null,
              payerPhone: payment.payerPhone ?? null,
              operationCode: payment.operationCode ?? null,
              reference: payment.reference ?? null,
              occurredAt: payment.occurredAt ?? null,
              validatedAt: new Date(),
              validationMode: "AUTO",
              validationNote: "Validado automáticamente por ValidPay",
            },
          });
        }
      } else {
        // payment.received (o cualquier otro evento) — crear receipt PENDIENTE
        receipt = await tx.paymentReceipt.create({
          data: {
            companyId,
            customerId: null,
            productId: null,
            digitalSaleId: null,
            // amountExpected se mantiene como mirror de amountPaid por compatibilidad
            amountExpected: payment.amount,
            amountPaid: payment.amount,
            currency: payment.currency ?? "PEN",
            status: "PENDIENTE",
            source,
            externalId: payment.externalId,
            payerName: payment.payerName || null,
            paymentSource: payment.paymentSource ?? null,
            payerPhone: payment.payerPhone ?? null,
            operationCode: payment.operationCode ?? null,
            reference: payment.reference ?? null,
            occurredAt: payment.occurredAt ?? null,
          },
        });
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
