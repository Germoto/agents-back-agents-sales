import { z } from "zod";
import { businessVerticalSchema } from "../business/business.schemas";

/**
 * Validación LAXA del manifest del ZIP de productos: aquí solo se comprueba la
 * envolvente (formato, versión, rubro, listas); la validación fuerte de cada
 * producto la hace productBodySchema al confirmar el import.
 */
export const manifestSchema = z.object({
  format: z.literal("flowapp-products-export"),
  version: z.literal(1),
  exportedAt: z.string(),
  vertical: businessVerticalSchema,
  sourceCompany: z.object({ name: z.string() }).nullish(),
  products: z.array(z.record(z.string(), z.unknown())).min(1).max(500),
  media: z.record(
    z.string(),
    z.object({ zipPath: z.string().min(1), size: z.number().nonnegative().optional() }),
  ),
  missingMedia: z.array(z.string()).default([]),
});

export type TransferManifest = z.infer<typeof manifestSchema>;

export const confirmImportBodySchema = z.object({
  uploadToken: z.string().min(16).max(128),
});
