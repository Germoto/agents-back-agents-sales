import { z } from "zod";
import { AppError } from "../../../lib/app-error";
import { PaymentAdapter, NormalizedPayment } from "./types";

/**
 * Adapter para el payload que emite ValidPay en el evento "payment.received".
 *
 * Formato esperado:
 * {
 *   "id": "cuid",           <- usado como externalId (paymentId en el eventPayload)
 *   "monto": 49.90,
 *   "nombre_cliente": "JUAN PEREZ",
 *   "source": "yape",
 *   "fecha": "2026-05-29T15:30:00.000Z"
 * }
 *
 * ValidPay también puede envolver el pago en un envelope de evento:
 * { "event": "payment.received", "sentAt": "...", "paymentId": "...", ...campos arriba }
 *
 * El adapter maneja ambas formas.
 */

const validpayPayloadSchema = z.object({
  // envelope opcional
  event: z.string().optional(),
  sentAt: z.string().optional(),

  // campos del pago (según payments.service.ts línea 40-46 de ValidPay)
  id: z.string().optional(),
  paymentId: z.string().optional(),
  monto: z.number().optional(),
  amount: z.number().optional(),
  nombre_cliente: z.string().optional(),
  payerName: z.string().optional(),
  source: z.string().optional(),
  fecha: z.string().optional(),
  occurredAt: z.string().optional(),
});

export const validpayAdapter: PaymentAdapter = {
  source: "validpay",

  normalize(raw: unknown): NormalizedPayment {
    const result = validpayPayloadSchema.safeParse(raw);
    if (!result.success) {
      throw new AppError("Payload de ValidPay inválido", 422);
    }

    const p = result.data;

    const externalId = p.id ?? p.paymentId;
    if (!externalId) throw new AppError("Payload ValidPay: falta id del pago", 422);

    const amountRaw = p.monto ?? p.amount;
    if (amountRaw == null) throw new AppError("Payload ValidPay: falta monto", 422);

    const payerName = p.nombre_cliente ?? p.payerName ?? "";
    const occurredAtRaw = p.fecha ?? p.occurredAt;
    const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();

    return {
      externalId,
      amount: amountRaw.toFixed(2),
      payerName: payerName.trim(),
      occurredAt,
      paymentSource: p.source?.toUpperCase(),
    };
  },
};
