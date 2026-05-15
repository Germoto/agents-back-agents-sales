import { z } from "zod";

export const updateOrderStatusParamsSchema = z.object({
  id: z.string().uuid(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["PEDIDO_REGISTRADO", "EN_COORDINACION", "DESPACHADO", "CANCELADO"]),
});
