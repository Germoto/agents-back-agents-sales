/**
 * Avisos al DUEÑO DE LA PLATAFORMA (superadmin) — el primer "notifyPlatformAdmin".
 * Canales, todos best-effort (jamás rompen el flujo que los dispara):
 *  - EMAIL (primario): mailer SMTP ya probado (es el que envía los códigos de
 *    verificación); destino = PlatformConfig.alertEmail → env.PLATFORM_ALERT_EMAIL
 *    → SMTP_USER.
 *  - WHATSAPP (refuerzo): solo si hay alertPhone Y el tenant de ventas de la
 *    plataforma ("FlowApp Ventas") tiene WhatsApp conectado (su config nace
 *    inerte a propósito; sin sender → skip silencioso).
 */

import { env } from "../../config/env";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { loadWhatsappSender, sendText } from "../agent/outbound";
import { getNotifyConfig, getSalesAgentPointer } from "./platform-config.service";

export async function notifyPlatformAdmin(opts: { subject: string; html: string; text: string }): Promise<void> {
  const config = await getNotifyConfig().catch(() => ({ alertEmail: null, alertPhone: null }));

  // Email (primario)
  try {
    const to = config.alertEmail || env.PLATFORM_ALERT_EMAIL || env.SMTP_USER || null;
    if (to && mailerEnabled()) {
      await sendMail({ to, subject: opts.subject, html: opts.html });
    }
  } catch (err) {
    console.warn("[platform-notify] email falló:", err instanceof Error ? err.message : err);
  }

  // WhatsApp (refuerzo, requiere tenant de ventas con WA activo)
  try {
    const phone = (config.alertPhone ?? "").replace(/\D/g, "");
    if (phone) {
      const pointer = await getSalesAgentPointer();
      if (pointer.companyId) {
        const sender = await loadWhatsappSender(pointer.companyId);
        if (sender && sender.provider !== "WEB") {
          await sendText(sender, phone, opts.text);
        }
      }
    }
  } catch (err) {
    console.warn("[platform-notify] whatsapp falló:", err instanceof Error ? err.message : err);
  }
}
