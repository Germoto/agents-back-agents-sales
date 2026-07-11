/**
 * Envío de correo vía SMTP genérico (nodemailer). Sin SMTP_HOST configurado el
 * canal email queda deshabilitado: sendMail devuelve { skipped: true } sin
 * lanzar, para que los flujos que lo usan (reportes) sigan operando por
 * WhatsApp. Transport singleton lazy.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";

let transport: Transporter | null = null;

export function mailerEnabled(): boolean {
  return Boolean(env.SMTP_HOST);
}

function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE === "1",
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}): Promise<{ skipped: boolean }> {
  if (!mailerEnabled()) return { skipped: true };
  await getTransport().sendMail({
    from: env.MAIL_FROM || env.SMTP_USER,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    attachments: opts.attachments,
  });
  return { skipped: false };
}
