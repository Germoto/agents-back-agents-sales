/**
 * Worker de recordatorios. Cada 60s busca ScheduledMessage PENDING vencidas,
 * las envía por WhatsApp (SMS Tools) y las marca SENT/FAILED. In-process
 * (sin Redis), arrancado desde server.ts.
 */

import cron from "node-cron";
import { ScheduledMessageStatus, ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { loadWhatsappSender, sendText, sendMedia, mediaKindFor } from "../agent/outbound";
import { recordMessage } from "../agent/conversation.service";
import { recheckPayment } from "../agent/agent.service";
import { resumeFlowOnTimeout } from "../flows/flow-engine";
import { clampToBusinessHours, normalizeQuietHours, type QuietHours } from "./quiet-hours";
import type { WhatsappSender } from "../agent/outbound";

const BATCH = 50;

type QuietConfig = { tz: string | null; quiet: QuietHours };

/** Carga (y cachea por batch) la zona horaria + ventana de horario del tenant. */
async function getQuietConfig(companyId: string, cache: Map<string, QuietConfig>): Promise<QuietConfig> {
  const hit = cache.get(companyId);
  if (hit) return hit;
  const [company, agentCfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { followupConfig: true } }),
  ]);
  const quiet = normalizeQuietHours((agentCfg?.followupConfig as { quietHours?: unknown } | null)?.quietHours);
  const cfg: QuietConfig = { tz: company?.timezone ?? null, quiet };
  cache.set(companyId, cfg);
  return cfg;
}
let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;
  cron.schedule("* * * * *", () => {
    void processDue().catch((err) =>
      console.error("[scheduler] tick error:", err instanceof Error ? err.message : err),
    );
  });
  console.log("[scheduler] worker de recordatorios iniciado (cada 60s)");
}

async function processDue(): Promise<void> {
  const now = new Date();
  const due = await prisma.scheduledMessage.findMany({
    where: { status: ScheduledMessageStatus.PENDING, sendAt: { lte: now } },
    orderBy: { sendAt: "asc" },
    take: BATCH,
    include: { customer: { select: { phone: true } } },
  });
  if (!due.length) return;

  const senderCache = new Map<string, WhatsappSender | null>();
  const quietCache = new Map<string, QuietConfig>();

  for (const msg of due) {
    // Horario hábil: los mensajes al cliente (no los timeouts internos de flujo
    // ni los reintentos de pago, que son urgentes) no se envían fuera de la
    // ventana del tenant; se reprograman al próximo horario válido sin
    // reclamarlos (cubre filas viejas o creadas con anticipación).
    if (msg.type !== ScheduledMessageType.FLOW_TIMEOUT && msg.type !== ScheduledMessageType.PAYMENT_RECHECK) {
      const qc = await getQuietConfig(msg.companyId, quietCache);
      if (qc.tz) {
        const next = clampToBusinessHours(now, qc.tz, qc.quiet);
        if (next.getTime() > now.getTime()) {
          await prisma.scheduledMessage.updateMany({
            where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
            data: { sendAt: next },
          });
          continue;
        }
      }
    }

    // Claim optimista: solo procede quien logra pasarlo de PENDING a SENT
    const claim = await prisma.scheduledMessage.updateMany({
      where: { id: msg.id, status: ScheduledMessageStatus.PENDING },
      data: { status: ScheduledMessageStatus.SENT, sentAt: new Date() },
    });
    if (claim.count === 0) continue;

    try {
      // Timeout de bloque de flujo: no envía un mensaje fijo, reanuda el motor
      // por la rama "sin responder" del bloque que quedó esperando.
      if (msg.type === ScheduledMessageType.FLOW_TIMEOUT) {
        await resumeFlowOnTimeout(msg);
        continue;
      }

      // Reintento de validación de pago: re-corre el matching y, si aparece,
      // aprueba y entrega; si no, deriva a un asesor (no es un mensaje fijo).
      if (msg.type === ScheduledMessageType.PAYMENT_RECHECK) {
        await recheckPayment({
          companyId: msg.companyId,
          customerId: msg.customerId,
          conversationId: msg.conversationId,
          metadata: msg.metadata,
        });
        continue;
      }

      if (!senderCache.has(msg.companyId)) {
        senderCache.set(msg.companyId, await loadWhatsappSender(msg.companyId));
      }
      const sender = senderCache.get(msg.companyId);
      if (!sender) throw new Error("empresa sin WhatsappConfig activa");

      const to = msg.customer.phone.replace(/\D/g, "");
      if (msg.mediaUrl) {
        // El tipo de media va en metadata (image|video|audio|pdf); default image.
        const mediaType = (msg.metadata as { mediaType?: string } | null)?.mediaType || "image";
        await sendMedia(sender, to, mediaKindFor(mediaType), msg.mediaUrl, msg.body);
      } else {
        await sendText(sender, to, msg.body);
      }

      // Registrar en la conversación para que aparezca en el panel
      if (msg.conversationId) {
        await recordMessage({
          companyId: msg.companyId,
          customerId: msg.customerId,
          conversationId: msg.conversationId,
          role: "ASSISTANT",
          message: msg.body,
          mediaUrl: msg.mediaUrl,
        });
      }
    } catch (err) {
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: {
          status: ScheduledMessageStatus.FAILED,
          failureReason: err instanceof Error ? err.message : "envío falló",
        },
      });
    }
  }
}
