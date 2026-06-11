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
import { resumeFlowOnTimeout } from "../flows/flow-engine";
import type { WhatsappSender } from "../agent/outbound";

const BATCH = 50;
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

  for (const msg of due) {
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
