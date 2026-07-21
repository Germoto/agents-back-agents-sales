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

export const updateMercadoPagoSchema = z.object({
  // undefined = no cambiar token; null = desconectar; string = nuevo token
  accessToken: z.string().trim().max(300).nullable().optional(),
  enabled: z.boolean().default(false),
  feeMode: z.enum(["TENANT", "CUSTOMER"]).default("TENANT"),
  feePercent: z.coerce.number().min(0).max(30).default(3.99),
  feeFixed: z.coerce.number().min(0).max(50).default(1),
  feeIgv: z.boolean().default(true),
});
