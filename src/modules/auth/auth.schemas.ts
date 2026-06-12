import { z } from "zod";

export const loginSchema = z.object({
  phone: z.string().min(6).max(20),
  password: z.string().min(6).max(100),
});

export const updateUiThemeSchema = z.object({
  mode: z.enum(["dark", "light"]),
  accentFrom: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentTo: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  preset: z.string().max(40).optional(),
});
