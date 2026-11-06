/**
 * Worker de estado de entrega. El gateway WhatsApp (SMS Tools) responde `ok` al
 * enviar pero encola el mensaje; el estado real (sent/failed) aparece después en
 * GET /get/wa.sent. Este worker, cada 60s, revisa SOLO los mensajes del bot
 * recientes que quedaron en "pending", reconcilia su estado, reintenta los que
 * fallaron (hasta 2 veces) y avisa al dueño si no se logra entregar.
 *
 * Liviano: si no hay pendientes recientes, no hace nada (índice
 * deliveryStatus+createdAt). 1 llamada getSent por empresa con pendientes.
 */

import cron from "node-cron";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { smsTools } from "../../lib/smstools-client";
import { loadWhatsappSender, sendText, sendMedia } from "./outbound";
import { notifyOwner } from "./conversation.service";
import { deliver, fallbackLinkText } from "./delivery";

const BATCH = 200;
const WINDOW_MIN = 30; // solo mensajes de los últimos 30 min
const GIVEUP_MIN = 10; // si tras 10 min no aparece en wa.sent, dejar de rastrear
const MAX_RETRIES = 2;
// Adjuntos de Drive: si a los 3 min no llegaron (1 check) pero un mensaje posterior
// del mismo chat sí, el celular está en línea y fue el adjunto: se manda el link.
const DRIVE_FALLBACK_AFTER_MIN = 3;
const DRIVE_FALLBACK_WINDOW_MIN = 60;
const fallbackInFlight = new Set<string>();
let started = false;

export function startDeliveryStatusWorker(): void {
  if (started) return;
  started = true;
  cron.schedule("* * * * *", () => {
    void reconcile().catch((err) =>
      console.error("[delivery] tick error:", err instanceof Error ? err.message : err),
    );
    void driveLinkFallback().catch((err) =>
      console.error("[delivery] respaldo de Drive falló:", err instanceof Error ? err.message : err),
    );
  });
  console.log("[delivery] worker de estado de entrega iniciado (cada 60s)");
}

/** image|video|audio|document según la extensión del URL (para reintentar media). */
function guessKindFromUrl(url: string): "image" | "video" | "audio" | "document" {
  const ext = (url.split("?")[0].split(".").pop() ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "mov", "3gp", "mkv", "webm"].includes(ext)) return "video";
  if (["mp3", "ogg", "opus", "m4a", "wav", "aac"].includes(ext)) return "audio";
  return "document";
}

function classify(status: unknown): "ok" | "failed" | "other" {
  const s = String(status ?? "").toLowerCase();
  if (s === "sent" || s === "delivered" || s === "read") return "ok";
  if (s === "failed" || s === "error" || s === "rejected" || s === "undelivered") return "failed";
  return "other";
}

export async function reconcile(): Promise<void> {
  const now = Date.now();
  const since = new Date(now - WINDOW_MIN * 60_000);
  const pending = await prisma.conversationMessage.findMany({
    where: { deliveryStatus: "pending", role: "ASSISTANT", createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: {
      id: true, companyId: true, customerId: true, gatewayId: true, deliveryRetries: true,
      message: true, mediaUrl: true, createdAt: true, rawPayload: true,
      customer: { select: { phone: true } },
    },
  });
  if (!pending.length) return;

  // Agrupar por empresa y traer una sola vez los enviados del gateway.
  const byCompany = new Map<string, typeof pending>();
  for (const m of pending) {
    if (!byCompany.has(m.companyId)) byCompany.set(m.companyId, []);
    byCompany.get(m.companyId)!.push(m);
  }

  for (const [companyId, msgs] of byCompany) {
    const sender = await loadWhatsappSender(companyId);
    if (!sender) continue;

    if (sender.provider !== "SMSTOOLS") {
      // META: el estado real llega por el webhook de statuses (meta-webhook).
      // Aquí solo hay fallback: si tras GIVEUP_MIN sigue "pending" (webhook
      // perdido), dejar de rastrear como "unknown".
      for (const m of msgs) {
        if (now - m.createdAt.getTime() > GIVEUP_MIN * 60_000) {
          await prisma.conversationMessage.update({ where: { id: m.id }, data: { deliveryStatus: "unknown" } });
        }
      }
      continue;
    }

    let statusById = new Map<string, unknown>();
    try {
      const sent = await smsTools.getSent({ apiUrl: sender.apiUrl, secret: sender.secret }, 1, 100);
      statusById = new Map(sent.map((s) => [String(s.id), s.status]));
    } catch (err) {
      console.warn("[delivery] getSent falló para", companyId, err instanceof Error ? err.message : err);
      continue; // se reintenta el próximo tick
    }

    for (const m of msgs) {
      const status = m.gatewayId ? statusById.get(m.gatewayId) : undefined;
      const kind = status === undefined ? "missing" : classify(status);

      if (kind === "ok") {
        await prisma.conversationMessage.update({ where: { id: m.id }, data: { deliveryStatus: "sent" } });
        continue;
      }

      if (kind === "failed") {
        if (isDriveAttachment(m.rawPayload)) {
          // Reintentar el mismo adjunto fallaría igual: driveLinkFallback manda el link.
          await prisma.conversationMessage.update({ where: { id: m.id }, data: { deliveryStatus: "failed" } });
          continue;
        }
        if (m.deliveryRetries < MAX_RETRIES) {
          // Claim del reintento (evita doble envío si dos ticks se solapan).
          const claim = await prisma.conversationMessage.updateMany({
            where: { id: m.id, deliveryStatus: "pending", deliveryRetries: m.deliveryRetries },
            data: { deliveryRetries: m.deliveryRetries + 1 },
          });
          if (claim.count === 0) continue;
          const to = m.customer.phone.replace(/\D/g, "");
          try {
            const r = m.mediaUrl
              ? await sendMedia(sender, to, guessKindFromUrl(m.mediaUrl), m.mediaUrl, m.message ?? undefined)
              : await sendText(sender, to, m.message ?? "");
            await prisma.conversationMessage.update({
              where: { id: m.id },
              data: { gatewayId: r.gatewayId ?? m.gatewayId },
            });
          } catch (err) {
            console.warn("[delivery] reintento falló", m.id, err instanceof Error ? err.message : err);
          }
        } else {
          await prisma.conversationMessage.update({ where: { id: m.id }, data: { deliveryStatus: "failed" } });
          const preview = (m.message ?? "[archivo]").slice(0, 60);
          await notifyOwner(
            companyId,
            `⚠️ No se pudo entregar un mensaje al cliente ${m.customer.phone.replace(/\D/g, "")} tras ${MAX_RETRIES} reintentos:\n"${preview}"\nRevísalo y contáctalo si es necesario.`,
          );
        }
        continue;
      }

      // No aparece en wa.sent todavía (en cola): si ya pasó el plazo, dejar de rastrear.
      if (now - m.createdAt.getTime() > GIVEUP_MIN * 60_000) {
        await prisma.conversationMessage.update({ where: { id: m.id }, data: { deliveryStatus: "unknown" } });
      }
    }
  }
}

function payloadOf(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function isDriveAttachment(raw: unknown): boolean {
  const p = payloadOf(raw);
  return p?.source === "drive" && typeof p.fallbackLink === "string";
}

/**
 * Respaldo de adjuntos de Drive que no llegaron al celular: si el gateway lo
 * marcó fallido, o sigue sin "delivered" mientras un mensaje POSTERIOR del bot
 * en el mismo chat sí llegó, se manda el link /file/d/… (una sola vez).
 */
export async function driveLinkFallback(): Promise<void> {
  const now = Date.now();
  const candidates = await prisma.conversationMessage.findMany({
    where: {
      role: "ASSISTANT",
      createdAt: { gte: new Date(now - DRIVE_FALLBACK_WINDOW_MIN * 60_000), lte: new Date(now - DRIVE_FALLBACK_AFTER_MIN * 60_000) },
      rawPayload: { path: ["source"], equals: "drive" },
      deliveryStatus: { notIn: ["delivered", "read"] },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: {
      id: true, companyId: true, customerId: true, conversationId: true, createdAt: true,
      deliveryStatus: true, rawPayload: true,
      customer: { select: { phone: true } },
    },
  });

  for (const m of candidates) {
    const payload = payloadOf(m.rawPayload);
    const link = typeof payload?.fallbackLink === "string" ? payload.fallbackLink : null;
    const conversationId = m.conversationId;
    if (!payload || !link || !conversationId || payload.fallbackSentAt || fallbackInFlight.has(m.id)) continue;

    if (m.deliveryStatus !== "failed") {
      const laterArrived = await prisma.conversationMessage.findFirst({
        where: {
          conversationId,
          role: "ASSISTANT",
          createdAt: { gt: m.createdAt },
          deliveryStatus: { in: ["delivered", "read"] },
        },
        select: { id: true },
      });
      if (!laterArrived) continue; // celular sin conexión o aún sin checks: esperar
    }

    fallbackInFlight.add(m.id);
    try {
      // Marcar primero: nunca mandar el link dos veces.
      await prisma.conversationMessage.update({
        where: { id: m.id },
        data: { rawPayload: { ...payload, fallbackSentAt: new Date().toISOString() } as Prisma.InputJsonValue },
      });
      const sender = await loadWhatsappSender(m.companyId);
      if (!sender) continue;
      const to = m.customer.phone.replace(/\D/g, "");
      await deliver(sender, to, { kind: "text", text: fallbackLinkText(link) }, {
        companyId: m.companyId,
        customerId: m.customerId,
        conversationId,
      });
      console.log(`[delivery] adjunto de Drive sin entregar (${m.id}): se envió el link de respaldo`);
    } finally {
      fallbackInFlight.delete(m.id);
    }
  }
}
