import { z } from "zod";

export const loginSchema = z.object({
  phone: z.string().min(6).max(20),
  password: z.string().min(6).max(100),
});
