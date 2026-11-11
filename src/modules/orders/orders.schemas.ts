import { z } from "zod";

export const orderIdParamsSchema = z.object({
  id: z.string().uuid(),
});

// Alias retrocompat (rutas existentes)
export const updateOrderStatusParamsSchema = orderIdParamsSchema;

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    "PEDIDO_REGISTRADO",
    "EN_COORDINACION",
    "DESPACHADO",
    "LISTO_PARA_RECOGER",
    "CANCELADO",
    "PENDIENTE_PAGO",
    "PAGADO",
    "ENTREGADO",
  ]),
  note: z.string().max(500).optional(),
});

export const registerOrderPaymentSchema = z.object({
  amount: z.coerce.number().positive().max(9_999_999),
  method: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
  kind: z.enum(["ADELANTO", "SALDO", "TOTAL", "OTRO"]).optional(),
});

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const updateOrderShippingSchema = z.object({
  deliveryType: z.enum(["DOMICILIO", "AGENCIA", "RECOJO"]).nullable().optional(),
  courier: optionalText(40),
  agencyId: z.string().uuid().nullable().optional(),
  agencyText: optionalText(200),
  agencyAddress: optionalText(300),
  recipientDocument: optionalText(20),
  recipientPhone: optionalText(20),
  trackingCode: optionalText(80),
  pickupKey: optionalText(40),
  shippingAmount: z.coerce.number().min(0).max(99_999).optional(),
  address: z.string().trim().max(500).optional(),
  reference: z.string().trim().max(500).optional(),
});
