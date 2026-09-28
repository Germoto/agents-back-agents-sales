/**
 * Envío de correo vía SMTP genérico (nodemailer). Sin SMTP_HOST configurado el
 * canal email queda deshabilitado: sendMail devuelve { skipped: true } sin
 * lanzar, para que los flujos que lo usan (reportes) sigan operando por
 * WhatsApp. Transport singleton lazy.
 *
 * El remitente es ÚNICO para toda la plataforma (MAIL_FROM); `fromName` solo
 * cambia el nombre visible (ej. "Pack Digital vía FlowApp"), nunca la dirección.
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

/** Dirección pura del remitente configurado (MAIL_FROM puede traer "Nombre <mail>"). */
function fromAddress(): string {
  const raw = env.MAIL_FROM || env.SMTP_USER || "";
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Nombre visible del remitente; la dirección sigue siendo la de la plataforma. */
  fromName?: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}): Promise<{ skipped: boolean }> {
  if (!mailerEnabled()) return { skipped: true };
  const from = opts.fromName
    ? { name: opts.fromName, address: fromAddress() }
    : env.MAIL_FROM || env.SMTP_USER;
  await getTransport().sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyTo,
    attachments: opts.attachments,
  });
  return { skipped: false };
}
