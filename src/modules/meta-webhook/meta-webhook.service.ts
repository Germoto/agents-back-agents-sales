/**
 * Procesamiento del webhook de Meta Cloud API.
 *
 * Mensajes entrantes: se resuelve el tenant por metadata.phone_number_id
 * (WhatsappConfig.metaPhoneNumberId), se persiste la media (Meta entrega un
 * media id cuya URL temporal exige el Bearer del tenant) y se delega en
 * handleInbound — el MISMO pipeline del agente que usa SMS Tools.
 *
 * Statuses (sent/delivered/read/failed): actualizan el deliveryStatus de
 * ConversationMessage por gatewayId (wamid) — reemplazan el polling de
 * getSent del worker de reconciliación. Un failed notifica al dueño; no se
 * reintenta (el fallo de Meta es determinista: ventana 24h, token, etc.).
 */

import { prisma } from "../../lib/prisma";
import { metaWa, META_REENGAGEMENT_CODE, META_WINDOW_REASON } from "../../lib/meta-wa-client";
import { decryptCredential } from "../../lib/credentials-crypto";
import { persistInboundMedia } from "../../lib/inbound-media";
import type { ParsedMetaWebhook, MetaInboundItem, MetaStatusUpdate } from "../../lib/meta-webhook-parser";
import { handleInbound } from "../agent/agent.service";
import { notifyOwner } from "../agent/conversation.service";

type MetaTenant = { companyId: string; accessToken: string };

async function resolveTenant(phoneNumberId: string): Promise<MetaTenant | null> {
  const cfg = await prisma.whatsappConfig.findFirst({
    where: { metaPhoneNumberId: phoneNumberId, provider: "META", isActive: true },
    select: { companyId: true, metaAccessToken: true, company: { select: { isActive: true } } },
  });
  if (!cfg || !cfg.company.isActive) return null;
  return { companyId: cfg.companyId, accessToken: decryptCredential(cfg.metaAccessToken) };
}

async function processMessage(item: MetaInboundItem): Promise<void> {
  const tenant = await resolveTenant(item.phoneNumberId);
  if (!tenant) {
    console.warn("[meta-webhook] mensaje para phone_number_id sin tenant:", item.phoneNumberId);
    return;
  }

  // Resolver y persistir la media ANTES de handleInbound: la URL de Meta dura
  // ~5 min y exige el token; se guarda local y el pipeline la ve como propia.
  if (item.mediaId && tenant.accessToken) {
    const info = await metaWa.getMediaInfo(tenant.accessToken, item.mediaId);
    if (info) {
      const local = await persistInboundMedia(tenant.companyId, info.url, item.inbound.type, {
        Authorization: `Bearer ${tenant.accessToken}`,
      });
      item.inbound.mediaUrl = local;
    }
    if (!item.inbound.mediaUrl) {
      console.warn("[meta-webhook] no se pudo descargar la media", item.mediaId, "companyId:", tenant.companyId);
    }
  }

  await handleInbound(item.inbound);
}

const STATUS_MAP: Record<MetaStatusUpdate["status"], string> = {
  sent: "sent",
  delivered: "sent",
  read: "sent",
  failed: "failed",
};

async function processStatus(st: MetaStatusUpdate): Promise<void> {
  const tenant = await resolveTenant(st.phoneNumberId);
  if (!tenant) return;

  const mapped = STATUS_MAP[st.status];
  const updated = await prisma.conversationMessage.updateMany({
    // Solo "upgrade" desde pending/unknown: un failed posterior a un delivered
    // no debe pisar el estado bueno, y viceversa los reintentos ya resueltos.
    where: {
      companyId: tenant.companyId,
      gatewayId: st.wamid,
      deliveryStatus: { in: ["pending", "unknown"] },
    },
    data: { deliveryStatus: mapped },
  });

  if (st.status === "failed" && updated.count > 0) {
    const reason =
      st.errorCode === META_REENGAGEMENT_CODE
        ? META_WINDOW_REASON
        : st.errorMessage ?? `código ${st.errorCode ?? "desconocido"}`;
    await notifyOwner(
      tenant.companyId,
      `⚠️ WhatsApp (Meta) no pudo entregar un mensaje${st.recipient ? ` al cliente ${st.recipient}` : ""}.\nMotivo: ${reason}`,
    ).catch(() => undefined);
  }
}

export async function processMetaWebhook(parsed: ParsedMetaWebhook): Promise<void> {
  for (const item of parsed.messages) {
    try {
      await processMessage(item);
    } catch (err) {
      console.error("[meta-webhook] error en mensaje entrante:", err instanceof Error ? err.message : err);
    }
  }
  for (const st of parsed.statuses) {
    try {
      await processStatus(st);
    } catch (err) {
      console.error("[meta-webhook] error en status:", err instanceof Error ? err.message : err);
    }
  }
}
