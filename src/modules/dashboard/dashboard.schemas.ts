import { z } from "zod";
import { DASHBOARD_PERIODS } from "./dashboard-periods";

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (usa AAAA-MM-DD)")
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), "Fecha inválida");

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const dashboardQuerySchema = z
  .object({
    period: z.preprocess(blankToUndefined, z.enum(DASHBOARD_PERIODS).optional()),
    from: z.preprocess(blankToUndefined, ymd.optional()),
    to: z.preprocess(blankToUndefined, ymd.optional()),
    productId: z.preprocess(blankToUndefined, z.string().uuid("Producto inválido").optional()),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "La fecha «desde» no puede ser posterior a «hasta»", path: ["from"] });

export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;

// Detalle de personas de una fila de «Por anuncio». `adSourceId` = id del anuncio, o
// «none» para la fila sin anuncio (orgánico).
export const adLeadsQuerySchema = z
  .object({
    period: z.preprocess(blankToUndefined, z.enum(DASHBOARD_PERIODS).optional()),
    from: z.preprocess(blankToUndefined, ymd.optional()),
    to: z.preprocess(blankToUndefined, ymd.optional()),
    productId: z.preprocess(blankToUndefined, z.string().uuid("Producto inválido").optional()),
    adSourceId: z.string().trim().min(1, "Falta el anuncio").max(120),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "La fecha «desde» no puede ser posterior a «hasta»", path: ["from"] });

export type AdLeadsQueryInput = z.infer<typeof adLeadsQuerySchema>;
