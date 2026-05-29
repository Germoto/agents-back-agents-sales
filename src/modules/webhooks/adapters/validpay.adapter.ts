import { z } from "zod";
import { AppError } from "../../../lib/app-error";
import { PaymentAdapter, NormalizedPayment } from "./types";

/**
 * Adapter para el payload que emite ValidPay en el evento "payment.received".
 *
 * Formato real (envelope con payload anidado):
 * {
 *   "id": "cmprbfe1g003b2vqe3fmhun9f",  <- event id (no usado como externalId)
 *   "event": "payment.received",
 *   "payload": {
 *     "id": "cmprbfe0s00372vqe60zme6ls",  <- paymentId real (externalId)
 *     "monto": 49.90,
 *     "moneda": "PEN",
 *     "nombre_cliente": "JUAN PEREZ",
 *     "telefono_cliente": "+51999...",   <- opcional
 *     "codigo_operacion": "12345",        <- opcional
 *     "referencia": "...",                <- opcional
 *     "source": "yape",
 *     "fecha": "2026-05-29T15:30:00.000Z"
 *   },
 *   "timestamp": 1780082949
 * }
 *
 * También acepta el formato plano (sin envelope) por compatibilidad.
 */

const paymentFieldsSchema = z.object({
  id: z.string().optional(),
  paymentId: z.string().optional(),
  monto: z.number().optional(),
  amount: z.number().optional(),
  moneda: z.string().optional(),
  currency: z.string().optional(),
  nombre_cliente: z.string().optional(),
  payerName: z.string().optional(),
  telefono_cliente: z.string().optional(),
  payerPhone: z.string().optional(),
  codigo_operacion: z.string().optional(),
  operationCode: z.string().optional(),
  numero_operacion: z.string().optional(),
  referencia: z.string().optional(),
  reference: z.string().optional(),
  source: z.string().optional(),
  fecha: z.string().optional(),
  occurredAt: z.string().optional(),
});

const envelopeSchema = z
  .object({
    id: z.string().optional(),
    event: z.string().optional(),
    sentAt: z.string().optional(),
    timestamp: z.number().optional(),
    payload: paymentFieldsSchema.optional(),
  })
  .passthrough();

export const validpayAdapter: PaymentAdapter = {
  source: "validpay",

  normalize(raw: unknown): NormalizedPayment {
    const env = envelopeSchema.safeParse(raw);
    if (!env.success) {
      throw new AppError("Payload de ValidPay inválido", 422);
    }

    // Si viene envelope con payload anidado, usar payload; sino, asumir top-level
    const pParsed = env.data.payload
      ? paymentFieldsSchema.safeParse(env.data.payload)
      : paymentFieldsSchema.safeParse(raw);

    if (!pParsed.success) {
      throw new AppError("Payload de ValidPay: estructura inválida", 422);
    }

    const p = pParsed.data;

    const externalId = p.id ?? p.paymentId;
    if (!externalId) throw new AppError("Payload ValidPay: falta id del pago", 422);

    const amountRaw = p.monto ?? p.amount;
    if (amountRaw == null) throw new AppError("Payload ValidPay: falta monto", 422);

    const payerName = p.nombre_cliente ?? p.payerName ?? "";
    const occurredAtRaw = p.fecha ?? p.occurredAt;
    const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();

    const payerPhone = p.telefono_cliente ?? p.payerPhone;
    const operationCode = p.codigo_operacion ?? p.numero_operacion ?? p.operationCode;
    const reference = p.referencia ?? p.reference;
    const currency = (p.moneda ?? p.currency ?? "PEN").toUpperCase();

    return {
      externalId,
      amount: amountRaw.toFixed(2),
      currency,
      payerName: payerName.trim(),
      occurredAt,
      paymentSource: p.source?.toUpperCase(),
      payerPhone: payerPhone?.trim() || undefined,
      operationCode: operationCode?.trim() || undefined,
      reference: reference?.trim() || undefined,
    };
  },
};
