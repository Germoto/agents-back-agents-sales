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

/** Plantilla de Meta usada cuando el destinatario está fuera de la ventana de 24h. */
export interface CampaignMetaTemplate {
  name: string;
  language: string;
  /** Valores de {{1}}, {{2}}, ... del cuerpo; admiten {nombre}. */
  params: string[];
}

export interface CampaignSendConfig {
  /** Segundos entre cada contacto. */
  intervalSec: number;
  /** Pausa automática después de N contactos (0 = sin pausa). */
  pauseEvery: number;
  /** Duración de la pausa automática en segundos. */
  pauseSec: number;
  /** Variar intervalos y pausas ±25% al azar (anti-ban). */
  randomize: boolean;
  /** Máximo de contactos procesados por día (0 = sin límite). Al llegar, pausa hasta el día siguiente. */
  dailyLimit: number;
  /** Horario de envío "HH:mm" en la zona horaria de la empresa (ambos o ninguno). */
  sendFrom: string | null;
  sendUntil: string | null;
  /** Excluir de la audiencia a contactos en atención humana (mutedNumbers / botPaused). */
  excludeMuted: boolean;
  /**
   * Solo tenants con proveedor META: plantilla a usar si el destinatario está
   * fuera de la ventana de 24h. Sin plantilla, esos destinatarios se marcan
   * FAILED con la razón visible (no se intenta el envío libre).
   */
  metaTemplate: CampaignMetaTemplate | null;
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
  randomize: true,
  dailyLimit: 0,
  sendFrom: null,
  sendUntil: null,
  excludeMuted: true,
  metaTemplate: null,
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseHHmm(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return HHMM_RE.test(s) ? s : null;
}

function parseCampaignMetaTemplate(raw: unknown): CampaignMetaTemplate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    language: String(o.language ?? "es").trim() || "es",
    params: Array.isArray(o.params) ? o.params.map((p) => String(p ?? "")) : [],
  };
}

export function parseSendConfig(raw: unknown): CampaignSendConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, min = 0) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  // Horario válido solo si vienen ambos extremos y son distintos
  const from = parseHHmm(o.sendFrom);
  const until = parseHHmm(o.sendUntil);
  const windowOk = from !== null && until !== null && from !== until;
  return {
    intervalSec: num(o.intervalSec, DEFAULT_SEND_CONFIG.intervalSec, 0),
    pauseEvery: num(o.pauseEvery, DEFAULT_SEND_CONFIG.pauseEvery, 0),
    pauseSec: num(o.pauseSec, DEFAULT_SEND_CONFIG.pauseSec, 0),
    randomize: o.randomize === undefined ? DEFAULT_SEND_CONFIG.randomize : Boolean(o.randomize),
    dailyLimit: num(o.dailyLimit, DEFAULT_SEND_CONFIG.dailyLimit, 0),
    sendFrom: windowOk ? from : null,
    sendUntil: windowOk ? until : null,
    excludeMuted: o.excludeMuted === undefined ? DEFAULT_SEND_CONFIG.excludeMuted : Boolean(o.excludeMuted),
    metaTemplate: parseCampaignMetaTemplate(o.metaTemplate),
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
