import { z } from "zod";

export const businessVerticalSchema = z.enum([
  "INFOPRODUCT",
  "PHYSICAL_GOODS",
  "RESTAURANT",
  "STREAMER",
  "SERVICE",
  "OTHER",
]);

export const deliveryConfigSchema = z
  .object({
    cost: z.string().nullable().optional(),
    time: z.string().nullable().optional(),
    areas: z.array(z.string()).default([]),
    pickupAvailable: z.boolean().default(false),
    requiresAddress: z.boolean().default(true),
  })
  .nullable()
  .optional();

export const updateBusinessSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  adminPhone: z.string().min(6),
  vertical: businessVerticalSchema.default("INFOPRODUCT"),
  timezone: z.string().min(1).default("America/Lima"),
  isActive: z.boolean().default(true),
  deliveryConfig: deliveryConfigSchema,
});
