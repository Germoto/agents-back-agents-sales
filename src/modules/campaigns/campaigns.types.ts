/**
 * Tipos del módulo de campañas masivas (broadcast).
 *
 * Las acciones y la config de envío se guardan como JSON en Campaign.actions /
 * Campaign.sendConfig (ver schema.prisma). Aquí están los tipos en runtime + los
 * parsers tolerantes que normalizan el JSON al leerlo.
 */

export type CampaignMessageType = "text" | "image" | "video" | "audio" | "document";

/** Un mensaje de la acción "send-message": texto puro o multimedia con caption. */
export interface CampaignMessageItem {
  type: CampaignMessageType;
  text?: string;
  mediaUrl?: string;
  fileName?: string;
}

export type CampaignAction =
  | { type: "send-message"; messages: CampaignMessageItem[] }
  | { type: "wait"; seconds: number }
  | { type: "tag"; addTagIds?: string[]; removeTagIds?: string[] }
  | { type: "crm-move"; crmId: string; columnId: string }
  | { type: "handoff"; notifyOwner?: boolean };

export interface CampaignSendConfig {
  /** Segundos entre cada contacto. */
  intervalSec: number;
  /** Pausa automática después de N contactos (0 = sin pausa). */
  pauseEvery: number;
  /** Duración de la pausa automática en segundos. */
  pauseSec: number;
  /** Excluir de la audiencia a contactos en atención humana (mutedNumbers / botPaused). */
  excludeMuted: boolean;
}

/** Un destinatario tal como lo seleccionó el usuario en el wizard. */
export interface AudienceRecipient {
  customerId?: string | null;
  phone: string;
  name?: string | null;
}

export interface CampaignAudience {
  recipients: AudienceRecipient[];
}

export const DEFAULT_SEND_CONFIG: CampaignSendConfig = {
  intervalSec: 10,
  pauseEvery: 10,
  pauseSec: 60,
  excludeMuted: true,
};

export function parseSendConfig(raw: unknown): CampaignSendConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, min = 0) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  return {
    intervalSec: num(o.intervalSec, DEFAULT_SEND_CONFIG.intervalSec, 0),
    pauseEvery: num(o.pauseEvery, DEFAULT_SEND_CONFIG.pauseEvery, 0),
    pauseSec: num(o.pauseSec, DEFAULT_SEND_CONFIG.pauseSec, 0),
    excludeMuted: o.excludeMuted === undefined ? DEFAULT_SEND_CONFIG.excludeMuted : Boolean(o.excludeMuted),
  };
}

export function parseActions(raw: unknown): CampaignAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is CampaignAction => a && typeof a === "object" && typeof (a as any).type === "string");
}

export function parseAudience(raw: unknown): CampaignAudience {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.recipients) ? o.recipients : [];
  const recipients: AudienceRecipient[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const phone = String((r as any).phone ?? "").trim();
    if (!phone) continue;
    recipients.push({
      customerId: (r as any).customerId ?? null,
      phone,
      name: (r as any).name ?? null,
    });
  }
  return { recipients };
}
