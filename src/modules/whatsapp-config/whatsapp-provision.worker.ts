/**
 * Worker de aprovisionamiento de SMS Tools. En el alta automática (registro en
 * un solo paso) la cuenta del cliente se crea aunque SMS Tools no responda; el
 * canal queda con `provisionPending` y secret vacío. Cada minuto este worker
 * reintenta crear el usuario + API key del proveedor y completa el canal.
 * Tras 30 intentos fallidos avisa al dueño de la plataforma (y sigue intentando).
 */

import crypto from "crypto";
import cron from "node-cron";
import { prisma } from "../../lib/prisma";
import { smsToolsAdmin, DEFAULT_API_KEY_PERMISSIONS } from "../../lib/smstools-admin-client";
import { notifyPlatformAdmin } from "../platform-config/platform-notify.service";

const NOTIFY_EVERY_ATTEMPTS = 30;
const attempts = new Map<string, number>();
let started = false;
let running = false;

export function startWhatsappProvisionWorker(): void {
  if (started) return;
  started = true;
  cron.schedule("* * * * *", () => {
    void tick().catch((err) => console.error("[provision] tick error:", err instanceof Error ? err.message : err));
  });
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const pending = await prisma.whatsappConfig.findMany({
      where: { provisionPending: true, provider: "SMSTOOLS" },
      include: { company: { include: { users: { where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, take: 1 } } } },
      take: 20,
    });
    for (const row of pending) {
      await provisionOne(row.companyId, row.company.slug, row.company.timezone, row.company.users[0] ?? null);
    }
  } finally {
    running = false;
  }
}

async function provisionOne(
  companyId: string,
  slug: string,
  timezone: string,
  admin: { name: string; email: string | null } | null,
): Promise<void> {
  let userId: number | null = null;
  try {
    const created = await smsToolsAdmin.createUser({
      name: admin?.name ?? slug,
      email: admin?.email ?? `${slug}@flowapp.pe`,
      password: crypto.randomBytes(18).toString("base64url"),
      timezone,
    });
    const parsed = Number(created?.id);
    userId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    if (!userId) throw new Error("SMS Tools no devolvió un id de usuario válido");
    const apiKey = await smsToolsAdmin.createApiKey(userId, `Tenant ${slug}`, DEFAULT_API_KEY_PERMISSIONS);
    if (!apiKey?.secret) throw new Error("SMS Tools no devolvió el secret de la API key");

    await prisma.whatsappConfig.update({
      where: { companyId },
      data: { secret: apiKey.secret, smsToolsUserId: userId, provisionPending: false },
    });
    attempts.delete(companyId);
    console.log(`[provision] canal SMS Tools listo para ${slug}`);
  } catch (err) {
    if (userId) {
      try {
        await smsToolsAdmin.deleteUser(userId);
      } catch {
        /* ignore */
      }
    }
    const n = (attempts.get(companyId) ?? 0) + 1;
    attempts.set(companyId, n);
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[provision] intento ${n} falló para ${slug}: ${reason}`);
    if (n % NOTIFY_EVERY_ATTEMPTS === 0) {
      await notifyPlatformAdmin({
        subject: `⚠️ Canal de WhatsApp pendiente: ${slug}`,
        html: `<p>La cuenta <b>${slug}</b> se activó sola pero SMS Tools sigue sin responder tras ${n} intentos.</p><p>Último error: ${reason}</p>`,
        text: `⚠️ *Canal de WhatsApp pendiente*\n\nLa cuenta ${slug} se activó sola pero SMS Tools sigue sin responder tras ${n} intentos.\nÚltimo error: ${reason}`,
      }).catch(() => undefined);
    }
  }
}
