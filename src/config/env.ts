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
  // Si se define, POST /api/agent/inbound exige el header x-api-key con este valor.
  AGENT_INBOUND_API_KEY: z.string().optional(),
  // Historial (turnos) que el agente envia a OpenAI por mensaje.
  AGENT_HISTORY_LIMIT: z.coerce.number().int().positive().default(16),
  // Ventana de debounce (ms): tras un inbound se espera este lapso para juntar la
  // ráfaga de mensajes del cliente y responder UNA sola vez. El temporizador se
  // reinicia con cada mensaje nuevo; el turno corre tras `sendAt = ultimo + ventana`.
  AGENT_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(6000),
  UPLOAD_DIR: z.string().default("uploads"),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(50),
  // Límite propio para recursos de capacitación del superadmin (PDF/videos).
  MAX_TRAINING_UPLOAD_MB: z.coerce.number().int().positive().default(500),
  SMSTOOLS_ADMIN_URL: z.string().default("https://smstools.pro/admin"),
  SMSTOOLS_ADMIN_TOKEN: z.string().optional().default(""),
  SMSTOOLS_API_URL: z.string().default("https://smstools.pro/api/send/whatsapp"),
  // --- Meta WhatsApp Cloud API (app única de la plataforma) ---
  META_GRAPH_VERSION: z.string().default("v21.0"),
  // App secret de la app Meta: firma X-Hub-Signature-256 del webhook entrante.
  META_APP_SECRET: z.string().optional().default(""),
  // Verify token que se pega en el dashboard de Meta al suscribir el webhook.
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional().default(""),
  // Clave para cifrar credenciales sensibles (metaAccessToken) en reposo con
  // AES-256-GCM. Si falta, se guardan en texto plano (igual que el secret de
  // SMS Tools hoy). Cambiarla invalida los tokens ya cifrados.
  CREDENTIALS_ENC_KEY: z.string().optional().default(""),
  // --- Monetización SaaS (paquetes / suscripciones / créditos) ---
  // Días de gracia tras vencer la suscripción antes de bloquear al tenant.
  BILLING_GRACE_DAYS: z.coerce.number().int().nonnegative().default(7),
  // Kill-switch del enforcement de billing: "0" => todas las empresas operan
  // como LEGACY (sin límites ni bloqueos) sin importar su suscripción.
  BILLING_ENFORCEMENT: z.string().default("1"),
  // --- Reportes automáticos: email vía SMTP genérico ---
  // Sin SMTP_HOST el canal email queda deshabilitado (los reportes por WhatsApp
  // siguen funcionando). Sirve cualquier SMTP: Gmail app-password, cPanel, Zoho...
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // "1" = TLS implícito (puerto 465); "0" = STARTTLS (587).
  SMTP_SECURE: z.string().default("0"),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  // Remitente, ej. 'Reportes <no-reply@tudominio.com>'. Default: SMTP_USER.
  MAIL_FROM: z.string().optional().default(""),
});

export const env = envSchema.parse(process.env);
