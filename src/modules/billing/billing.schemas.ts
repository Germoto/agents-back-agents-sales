import { z } from "zod";
import { businessVerticalSchema } from "../business/business.schemas";

export const planModuleSchema = z.enum([
  "CAMPAIGNS",
  "CRM",
  "FLOWS",
  "QUICK_REPLIES",
  "FUNNEL",
  "META_PROVIDER",
]);

const round2 = (n: number) => Math.round(n * 100) / 100;

// Dinero >= 0 (acepta string del form) redondeado a 2 decimales.
const moneySchema = z.coerce.number().min(0).transform(round2);

// Dinero opcional que permite null/"" (campos "sin límite" / "sin precio").
const nullableNumber = (inner: z.ZodType<number>) =>
  z.preprocess((v) => (v === null || v === undefined || v === "" ? null : Number(v)), inner.nullable());

// ---------------- Tenant ----------------

export const redeemVoucherSchema = z.object({
  code: z.string().trim().min(4).max(64),
});

// ---------------- Paquetes ----------------

export const planInputSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => (v ? v : null)),
  priceUsd: moneySchema.default(0),
  pricePen: moneySchema.default(0),
  monthlyLeadLimit: nullableNumber(z.number().int().min(1)).default(null),
  extraLeadPricePen: nullableNumber(z.number().min(0.01).transform(round2)).default(null),
  verticals: z.array(businessVerticalSchema).min(1, "Elige al menos un rubro").default(["INFOPRODUCT"]),
  modules: z.array(planModuleSchema).default([]),
  isPublic: z.boolean().default(false),
  isHighlighted: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});

// ---------------- Suscripciones ----------------

export const assignSubscriptionSchema = z.object({
  companyId: z.string().uuid(),
  planId: z.string().uuid(),
  months: z.coerce.number().int().min(1).max(36).default(1),
});

export const extendSubscriptionSchema = z.object({
  months: z.coerce.number().int().min(1).max(36),
});

// ---------------- Vales ----------------

export const voucherBatchSchema = z
  .object({
    name: z.string().trim().min(2).max(40),
    count: z.coerce.number().int().min(1).max(500).default(1),
    type: z.enum(["PLAN", "CREDIT"]).default("PLAN"),
    planId: z.string().uuid().optional(),
    months: z.coerce.number().int().min(1).max(36).optional(),
    creditAmountPen: z.coerce.number().min(0.01).transform(round2).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === "PLAN") {
      if (!val.planId) ctx.addIssue({ code: "custom", path: ["planId"], message: "Elige el paquete del vale" });
      if (!val.months) ctx.addIssue({ code: "custom", path: ["months"], message: "Indica los meses del vale" });
    } else if (!val.creditAmountPen) {
      ctx.addIssue({ code: "custom", path: ["creditAmountPen"], message: "Indica el monto en S/ del vale" });
    }
  });

export const vouchersQuerySchema = z.object({
  status: z.enum(["available", "redeemed"]).optional(),
});

// ---------------- Créditos ----------------

export const adjustCreditsSchema = z.object({
  companyId: z.string().uuid(),
  amountPen: z.coerce
    .number()
    .transform(round2)
    .refine((v) => v !== 0, "El monto no puede ser 0"),
  note: z.string().trim().max(200).optional(),
});

// ---------------- Params ----------------

export const billingIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const billingCompanyIdParamsSchema = z.object({
  companyId: z.string().uuid(),
});
