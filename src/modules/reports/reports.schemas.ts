import { z } from "zod";

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const updateReportConfigSchema = z.object({
  email: z.preprocess(emptyToNull, z.string().trim().email("Email inválido").nullable()),
  waPhone: z.preprocess(
    emptyToNull,
    z.string().trim().regex(/^\+?\d{8,20}$/, "Número de WhatsApp inválido").nullable(),
  ),
  dailyEnabled: z.boolean(),
  weeklyEnabled: z.boolean(),
  monthlyEnabled: z.boolean(),
  sendHour: z.coerce.number().int().min(0).max(23),
});

export type UpdateReportConfigInput = z.infer<typeof updateReportConfigSchema>;

export const testReportSchema = z.object({
  kind: z.enum(["daily", "weekly", "monthly"]),
});
