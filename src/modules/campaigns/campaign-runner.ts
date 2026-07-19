/**
 * Ejecuta la secuencia de acciones de una campaña para UN destinatario.
 *
 * Reutiliza la infraestructura de envío del agente:
 *  - loadWhatsappSender + flushOutbox/deliver (envío secuencial con media, firma,
 *    registro en ConversationMessage).
 *  - muteCustomerToHuman (modo humano), applyCrmAndTagActions (etiquetar/mover CRM),
 *    notifyOwner (aviso al dueño).
 *
 * Para acciones que requieren un Customer/Conversation (enviar, etiquetar, mover,
 * handoff) se hace upsert con loadOrCreateConversation. Los números importados que
 * aún no eran Customer se materializan aquí, en el momento del envío.
 */

import { prisma } from "../../lib/prisma";
import { loadWhatsappSender, mediaKindFor } from "../agent/outbound";
import { flushOutbox, sleep, type DeliveryIds } from "../agent/delivery";
import type { OutboxMessage } from "../agent/agent-tools";
import { muteCustomerToHuman } from "../agent/agent-tools";
import { loadOrCreateConversation, notifyOwner, saveState, recordMessage } from "../agent/conversation.service";
import { applyCrmAndTagActions } from "../crm/crm.service";
import { metaWa, META_WINDOW_REASON } from "../../lib/meta-wa-client";
import { isWithin24hWindow, substituteTemplateParams } from "../agent/session-window";
import {
  parseActions,
  type CampaignAction,
  type CampaignMessageItem,
  type CampaignMetaTemplate,
} from "./campaigns.types";

export interface RunnerRecipient {
  id?: string;
  customerId?: string | null;
  phone: string;
  name?: string | null;
}

export interface RunnerCampaign {
  id: string;
  name: string;
  actions: unknown;
  /** Producto en foco de la campaña; se siembra en Conversation.state. */
  contextProductId?: string | null;
  /** Etiquetas a aplicar a cada destinatario alcanzado. */
  contextTagIds?: string[];
  /** Plantilla de Meta para destinatarios fuera de la ventana de 24h (opcional). */
  metaTemplate?: CampaignMetaTemplate | null;
}

/** Reemplaza placeholders simples del mensaje ({nombre}) con datos del destinatario. */
function substituteVars(text: string, recipient: RunnerRecipient): string {
  const name = (recipient.name ?? "").trim();
  return text.replace(/\{nombre\}/gi, name);
}

/** Mapea un mensaje de campaña al OutboxMessage que entiende flushOutbox. */
function toOutbox(msg: CampaignMessageItem, recipient: RunnerRecipient): OutboxMessage {
  if (msg.type === "text") {
    return { kind: "text", text: substituteVars(msg.text ?? "", recipient) };
  }
  return {
    kind: "media",
    mediaUrl: msg.mediaUrl,
    mediaKind: mediaKindFor(msg.type),
    caption: msg.text ? substituteVars(msg.text, recipient) : undefined,
    fileName: msg.fileName,
  };
}

function actionsNeedConversation(actions: CampaignAction[]): boolean {
  return actions.some(
    (a) => a.type === "send-message" || a.type === "handoff" || a.type === "tag" || a.type === "crm-move",
  );
}

/** Únicos de un array de ids, ignorando vacíos. */
function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

/**
 * Ejecuta todas las acciones de la campaña contra el destinatario. Lanza si no hay
 * cuenta de WhatsApp activa o si falla un envío crítico (el driver lo marca FAILED).
 * Cuando `persist` es true, va actualizando CampaignRecipient.actionIndex (reanudación).
 */
export async function runRecipientActions(
  companyId: string,
  campaign: RunnerCampaign,
  recipient: RunnerRecipient,
  opts: { persist: boolean } = { persist: true },
): Promise<void> {
  const actions = parseActions(campaign.actions);
  if (!actions.length) return;

  const sender = await loadWhatsappSender(companyId);
  if (!sender) throw new Error("No hay una cuenta de WhatsApp activa para enviar");

  const to = recipient.phone.replace(/\D/g, "");
  if (!to) throw new Error("Teléfono inválido");

  const contextTagIds = uniqueIds(campaign.contextTagIds ?? []);
  const hasContext = Boolean(campaign.contextProductId) || contextTagIds.length > 0;

  let customerId = recipient.customerId ?? null;
  let conversationId: string | null = null;

  if (actionsNeedConversation(actions) || hasContext) {
    const convo = await loadOrCreateConversation(companyId, recipient.phone, null);
    customerId = convo.customerId;
    conversationId = convo.conversationId;

    // Sembrar el CONTEXTO de la campaña ANTES de enviar los mensajes:
    //  - Producto en foco: se guarda en Conversation.state (selectedProductId) para
    //    que el agente sepa de qué producto hablar cuando el cliente responda. NO se
    //    marca presentado (presentedProductIds), así el bot puede enviar la ficha si
    //    el cliente pide más info.
    //  - Etiquetas: se aplican al Customer alcanzado (segmentación).
    if (campaign.contextProductId) {
      await saveState(conversationId, { ...convo.state, selectedProductId: campaign.contextProductId }).catch(
        () => undefined,
      );
    }
    if (contextTagIds.length && customerId) {
      await applyCrmAndTagActions(companyId, customerId, { tagIds: contextTagIds }).catch(() => undefined);
    }
  }

  // Ventana de 24h de Meta: los mensajes libres de la campaña solo pueden ir a
  // destinatarios que escribieron hace <24h. Fuera de ventana: plantilla de la
  // campaña (si está configurada, UNA vez por destinatario) o FAILED con razón.
  let outsideMetaWindow = false;
  if (sender.provider === "META" && actions.some((a) => a.type === "send-message")) {
    outsideMetaWindow = customerId ? !(await isWithin24hWindow(companyId, customerId)) : true;
  }
  let templateSent = false;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    if (action.type === "send-message") {
      if (sender.provider === "META" && outsideMetaWindow) {
        const tpl = campaign.metaTemplate;
        if (!tpl) throw new Error(META_WINDOW_REASON);
        if (!templateSent) {
          const params = substituteTemplateParams(tpl.params, { nombre: recipient.name });
          await metaWa.sendTemplate(sender, to, tpl.name, tpl.language, params);
          templateSent = true;
          if (conversationId) {
            await recordMessage({
              companyId,
              customerId: customerId!,
              conversationId,
              role: "ASSISTANT",
              message: `📋 Plantilla de Meta "${tpl.name}" enviada (destinatario fuera de la ventana de 24h).`,
            }).catch(() => undefined);
          }
        }
        // Los demás mensajes libres de la campaña se omiten: Meta los rechazaría.
      } else {
        const outbox = action.messages.map((m) => toOutbox(m, recipient));
        const ids: DeliveryIds = {
          companyId,
          customerId: customerId!,
          conversationId: conversationId!,
        };
        const result = await flushOutbox(sender, to, outbox, ids);
        // A diferencia del agente (donde el error se traga para no romper el
        // turno), en campañas un rechazo del gateway debe marcar el FAILED.
        if (result.failed > 0) {
          throw new Error(
            result.sent === 0
              ? "El gateway rechazó el envío del mensaje"
              : `El gateway rechazó ${result.failed} de ${result.sent + result.failed} mensajes`,
          );
        }
      }
    } else if (action.type === "wait") {
      await sleep(Math.max(0, action.seconds) * 1000);
    } else if (action.type === "tag") {
      if (action.addTagIds?.length && customerId) {
        await applyCrmAndTagActions(companyId, customerId, { tagIds: action.addTagIds });
      }
      if (action.removeTagIds?.length && customerId) {
        await prisma.customerTagLink
          .deleteMany({ where: { customerId, tagId: { in: action.removeTagIds } } })
          .catch(() => undefined);
      }
    } else if (action.type === "crm-move") {
      if (customerId) {
        await applyCrmAndTagActions(companyId, customerId, {
          crmId: action.crmId,
          crmColumnId: action.columnId,
        });
      }
    } else if (action.type === "handoff") {
      if (conversationId) {
        await muteCustomerToHuman(companyId, conversationId, recipient.phone);
      }
      if (action.notifyOwner) {
        await notifyOwner(
          companyId,
          `📣 Campaña "${campaign.name}": ${recipient.phone} pasó a atención humana.`,
        );
      }
    }

    if (opts.persist && recipient.id) {
      await prisma.campaignRecipient
        .update({ where: { id: recipient.id }, data: { actionIndex: i + 1 } })
        .catch(() => undefined);
    }
  }
}
