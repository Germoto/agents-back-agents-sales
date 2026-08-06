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
    "CANCELADO",
    "PENDIENTE_PAGO",
    "PAGADO",
    "ENTREGADO",
  ]),
  note: z.string().max(500).optional(),
});
