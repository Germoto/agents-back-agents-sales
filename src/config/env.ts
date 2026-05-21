import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET es obligatorio"),
  JWT_EXPIRES_IN: z.string().default("7d"),
  BOT_CONFIG_API_KEY: z.string().optional(),
  UPLOAD_DIR: z.string().default("uploads"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(50),
  SMSTOOLS_ADMIN_URL: z.string().default("https://smstools.pro/admin"),
  SMSTOOLS_ADMIN_TOKEN: z.string().optional().default(""),
  SMSTOOLS_API_URL: z.string().default("https://smstools.pro/api/send/whatsapp"),
});

export const env = envSchema.parse(process.env);
