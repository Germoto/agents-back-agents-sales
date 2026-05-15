import { z } from "zod";

export const upsertPaymentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  notificationPhone: z.string().min(6, "notificationPhone es obligatoria"),
  methods: z.array(
    z.object({
      method: z.string().min(1),
      number: z.string().min(1),
      holder: z.string().min(1),
      sortOrder: z.coerce.number().int().min(0).default(0),
    }),
  ).min(1, "Debe existir al menos un medio de pago"),
  paymentMode: z.enum(["BEFORE_DELIVERY", "CASH_ON_DELIVERY", "MANUAL"]),
});
