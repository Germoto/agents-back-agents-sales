import { z } from "zod";

export const receiptIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const rejectReceiptSchema = z.object({
  rejectionReason: z.string().min(1),
});

export const approveReceiptSchema = z.object({
  // Asociar el comprobante a un producto al aprobarlo manualmente (opcional)
  productId: z.string().uuid().nullable().optional(),
});
