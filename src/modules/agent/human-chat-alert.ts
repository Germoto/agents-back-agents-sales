/**
 * Aviso al dueño: «un cliente escribió en un chat que está en atención humana».
 *
 * Cuando el bot está pausado, el mensaje del cliente solo se guarda; si el panel
 * no está abierto nadie se entera. Este aviso sale por el WhatsApp del negocio al
 * número de notificaciones (o al del admin), con dos frenos para no ser spam:
 *   - si un asesor respondió (mensaje ADMIN) hace menos de 10 min, está atendiendo → no avisa;
 *   - como máximo un aviso cada 30 min por chat (state.humanAlertAt).
 * Se apaga por negocio con AgentConfig.humanChatAlerts = false.
 */

import { prisma } from "../../lib/prisma";
import { chatLinkLine } from "../../lib/panel-url";
import { loadWhatsappSender, sendText } from "./outbound";
import type { ConversationState } from "./conversation.service";
import type { Prisma } from "@prisma/client";

const ADMIN_ACTIVE_WINDOW_MS = 10 * 60_000;
const ALERT_COOLDOWN_MS = 30 * 60_000;
const PREVIEW_CHARS = 120;

export type HumanChatAlertInput = {
  companyId: string;
  conversationId: string;
  customerId: string;
  customerPhone: string;
  state: ConversationState | null | undefined;
  text: string | null | undefined;
  hasMedia: boolean;
  /** Config ya cargada por el inbound (buildBotConfig). Si falta, se resuelve de la DB. */
  config?: AlertConfig | null;
};

type AlertConfig = {
  agent?: { humanChatAlerts?: boolean };
  payment?: { notification?: { whatsappPhone?: string | null } | null };
  business?: { adminPhone?: string | null };
};

async function resolveAlertConfig(companyId: string): Promise<AlertConfig> {
  const [agent, pay, company] = await Promise.all([
    prisma.agentConfig.findUnique({ where: { companyId }, select: { humanChatAlerts: true } }),
    prisma.paymentConfig.findUnique({ where: { companyId }, select: { notificationPhone: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { adminPhone: true } }),
  ]);
  return {
    agent: { humanChatAlerts: agent?.humanChatAlerts ?? true },
    payment: { notification: { whatsappPhone: pay?.notificationPhone ?? null } },
    business: { adminPhone: company?.adminPhone ?? null },
  };
}

/** Inyectable en tests. */
export const humanChatAlertInternals = { now: () => Date.now() };

/** Devuelve true si se envió el aviso. Nunca lanza (best-effort). */
export async function notifyHumanChatMessage(input: HumanChatAlertInput): Promise<boolean> {
  try {
    const config = input.config ?? (await resolveAlertConfig(input.companyId));
    if (config.agent?.humanChatAlerts === false) return false;
    const ownerPhone = (config.payment?.notification?.whatsappPhone || config.business?.adminPhone || "").replace(/\D/g, "");
    if (!ownerPhone) return false;

    const now = humanChatAlertInternals.now();
    const lastAlert = input.state?.humanAlertAt ? Date.parse(input.state.humanAlertAt) : NaN;
    if (Number.isFinite(lastAlert) && now - lastAlert < ALERT_COOLDOWN_MS) return false;

    const [customer, lastAdmin] = await Promise.all([
      prisma.customer.findUnique({ where: { id: input.customerId }, select: { name: true, optOutAt: true } }),
      prisma.conversationMessage.findFirst({
        where: { conversationId: input.conversationId, role: "ADMIN" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
    if (customer?.optOutAt) return false;
    if (lastAdmin && now - lastAdmin.createdAt.getTime() < ADMIN_ACTIVE_WINDOW_MS) return false;

    const sender = await loadWhatsappSender(input.companyId);
    if (!sender) return false;

    const num = input.customerPhone.replace(/\D/g, "");
    const who = customer?.name?.trim() ? `${customer.name.trim()} (${input.customerPhone})` : input.customerPhone;
    const text = (input.text ?? "").trim();
    const preview = text ? `«${text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text}»` : "";
    const media = input.hasMedia ? (preview ? " 📎 (con adjunto)" : "📎 Envió un adjunto") : "";
    const message =
      `💬 Mensaje nuevo en un chat en atención humana\n` +
      `Cliente: ${who}\n` +
      `${preview}${media}\n\n` +
      `El bot sigue pausado: respóndele tú.\n` +
      `• Responder: *${num} tu mensaje*\n` +
      `• Reactivar el bot: *BOT ${num}*` +
      chatLinkLine(input.conversationId);

    await sendText(sender, ownerPhone, message);

    const nextState: ConversationState = { ...(input.state ?? {}), humanAlertAt: new Date(now).toISOString() };
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: { state: nextState as unknown as Prisma.InputJsonValue },
    });
    return true;
  } catch (err) {
    console.warn("[agent] aviso de chat en atención humana falló:", err instanceof Error ? err.message : err);
    return false;
  }
}
