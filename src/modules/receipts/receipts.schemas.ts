import { z } from "zod";

export const receiptIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const rejectReceiptSchema = z.object({
  rejectionReason: z.string().min(1),
});
