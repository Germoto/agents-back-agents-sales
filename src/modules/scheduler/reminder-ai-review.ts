/**
 * Revisión con IA antes de enviar un recordatorio de secuencia (carrito abandonado /
 * dejado en visto). Es OPCIONAL y nace apagada (`followupConfig.aiReview`): cuesta una
 * consulta corta a la IA del negocio por recordatorio revisado.
 *
 * Para gastar lo mínimo solo consulta cuando el cliente respondió DESPUÉS de un
 * recordatorio anterior (el primer recordatorio de cada cliente no se revisa) y hasta
 * el tope diario del negocio. La IA solo decide enviar u omitir ESE paso: no reescribe
 * el mensaje ni detiene la secuencia. Si falla o tarda, el recordatorio se envía.
 */
import { Prisma, ScheduledMessageStatus, ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { resolveAiSettings, parseJsonLoose } from "../../lib/ai-providers";
import { chatCompletion } from "../../lib/openai";
import { consumePlatformAi, getPlatformAiQuota } from "../agent/platform-ai-quota";
import { zonedParts, zonedTimeToUtc } from "./quiet-hours";
import { FOLLOWUP_MEMORY_DAYS, normalizeSmartFollowup, type SmartFollowup } from "./smart-followup";

const REVIEW_TIMEOUT_MS = 8_000;
const HISTORY_MESSAGES = 8;
const MESSAGE_MAX_CHARS = 280;
const SEQUENCE_TYPES: ScheduledMessageType[] = [ScheduledMessageType.ABANDONED_CART, ScheduledMessageType.LEFT_ON_READ];

/** Prefijo del motivo en `failureReason` (el panel y el Copiloto lo reconocen). */
export const AI_SKIP_PREFIX = "Omitido por revisión IA";

/** Criterio por defecto; el dueño puede reemplazarlo con su texto (`aiReview.criteria`). */
export const DEFAULT_AI_REVIEW_CRITERIA =
  "No enviar si el cliente dijo que no le interesa, que ya compró, pidió que no le escriban, o pidió tiempo / dijo que escribirá después y ese momento todavía no llega.";

export type AiReviewVerdict =
  | { reviewed: false }
  | { reviewed: true; send: true }
  | { reviewed: true; send: false; reason: string };

/** Inicio del día (00:00) en la zona del negocio. */
function dayStart(now: Date, tz: string | null): Date {
  try {
    const p = zonedParts(now, tz || "America/Lima");
    return zonedTimeToUtc(p.year, p.month, p.day, 0, tz || "America/Lima");
  } catch {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

/** Contador del día: recordatorios revisados y cuántos de ellos se omitieron. */
export async function getAiReviewStats(
  companyId: string,
  tz: string | null,
  now = new Date(),
): Promise<{ revisadosHoy: number; omitidosHoy: number }> {
  const since = dayStart(now, tz);
  // `updatedAt` acota por índice; el filtro JSON solo ve filas que ya tienen la marca.
  const base = { companyId, updatedAt: { gte: since }, metadata: { path: ["aiReviewAt"], gte: since.getTime() } };
  const [revisadosHoy, omitidosHoy] = await Promise.all([
    prisma.scheduledMessage.count({ where: base }),
    prisma.scheduledMessage.count({
      where: { ...base, status: ScheduledMessageStatus.CANCELLED, failureReason: { startsWith: AI_SKIP_PREFIX } },
    }),
  ]);
  return { revisadosHoy, omitidosHoy };
}

/** Resumen para el panel y el Copiloto: interruptor, tope y uso del día. */
export async function getAiReviewOverview(
  companyId: string,
): Promise<{ enabled: boolean; tope: number; revisadosHoy: number; omitidosHoy: number }> {
  const [company, agentConfig] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { followupConfig: true } }),
  ]);
  const smart = normalizeSmartFollowup(agentConfig?.followupConfig);
  const stats = await getAiReviewStats(companyId, company?.timezone ?? null);
  return { enabled: smart.aiReview.enabled, tope: smart.aiReview.dailyLimit, ...stats };
}

type ReviewRow = {
  id: string;
  companyId: string;
  customerId: string;
  conversationId: string | null;
  type: ScheduledMessageType;
  body: string;
  metadata: Prisma.JsonValue | null;
};

function fmtWhen(date: Date, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat("es-PE", {
      timeZone: tz || "America/Lima",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Decide si un recordatorio YA reclamado (el worker lo pasó a SENT) debe salir.
 * `usage` es el contador del día por empresa, compartido en la pasada del worker
 * (se carga una vez y se va sumando). Nunca lanza: ante cualquier problema, se envía.
 */
export async function reviewReminderBeforeSend(
  row: ReviewRow,
  opts: { smart: SmartFollowup; tz: string | null; now: Date; usage: Map<string, number> },
): Promise<AiReviewVerdict> {
  const { smart, tz, now, usage } = opts;
  if (!smart.aiReview.enabled) return { reviewed: false };
  if (!SEQUENCE_TYPES.includes(row.type)) return { reviewed: false };
  const meta = (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata : {}) as Record<string, unknown>;
  if (meta.manual === true || meta.postponed === true) return { reviewed: false };

  try {
    // 1) ¿El cliente respondió después de un recordatorio anterior? Si no, no se gasta.
    const memoryFloor = new Date(now.getTime() - FOLLOWUP_MEMORY_DAYS * 24 * 60 * 60 * 1000);
    const previous = await prisma.scheduledMessage.findFirst({
      where: {
        companyId: row.companyId,
        customerId: row.customerId,
        type: { in: SEQUENCE_TYPES },
        status: ScheduledMessageStatus.SENT,
        sentAt: { gt: memoryFloor },
        id: { not: row.id },
      },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });
    if (!previous?.sentAt) return { reviewed: false };
    const convoWhere = row.conversationId
      ? { conversationId: row.conversationId }
      : { companyId: row.companyId, customerId: row.customerId };
    const replied = await prisma.conversationMessage.findFirst({
      where: { ...convoWhere, role: "USER", createdAt: { gt: previous.sentAt } },
      select: { id: true },
    });
    if (!replied) return { reviewed: false };

    // 2) Tope diario del negocio.
    if (!usage.has(row.companyId)) {
      usage.set(row.companyId, (await getAiReviewStats(row.companyId, tz, now)).revisadosHoy);
    }
    if ((usage.get(row.companyId) ?? 0) >= smart.aiReview.dailyLimit) return { reviewed: false };

    // 3) IA disponible (key propia o cupo de la IA de prueba de la plataforma).
    const agentConfig = await prisma.agentConfig.findUnique({
      where: { companyId: row.companyId },
      select: { aiProvider: true, openaiApiKey: true, openaiModel: true },
    });
    if (!agentConfig?.openaiApiKey) return { reviewed: false };
    const quota = await getPlatformAiQuota(row.companyId);
    if (quota.exhausted) return { reviewed: false };
    const { apiKey, model, baseUrl } = resolveAiSettings(agentConfig);
    if (!apiKey) return { reviewed: false };

    const history = await prisma.conversationMessage.findMany({
      where: { ...convoWhere, role: { in: ["USER", "ASSISTANT", "ADMIN"] } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_MESSAGES,
      select: { role: true, message: true, mediaUrl: true, createdAt: true },
    });
    const lines = history.reverse().map((m) => {
      const who = m.role === "USER" ? "Cliente" : "Negocio";
      const text = (m.message ?? "").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX_CHARS) || (m.mediaUrl ? "[adjunto]" : "");
      return `[${fmtWhen(m.createdAt, tz)}] ${who}: ${text}`;
    });

    // Desde aquí la consulta cuenta para el tope aunque falle (ya se gastó).
    usage.set(row.companyId, (usage.get(row.companyId) ?? 0) + 1);
    void consumePlatformAi(row.companyId).catch(() => undefined);

    const criteria = smart.aiReview.criteria || DEFAULT_AI_REVIEW_CRITERIA;
    const call = chatCompletion({
      apiKey,
      model,
      baseUrl,
      temperature: 0,
      maxTokens: 150,
      messages: [
        {
          role: "system",
          content:
            'Eres el filtro de recordatorios automáticos de WhatsApp de un negocio. Lees los últimos mensajes del chat y decides si conviene enviar AHORA el recordatorio. Responde SOLO con un JSON: {"enviar": true|false, "motivo": "frase corta en español"}. Ante la duda, enviar.',
        },
        {
          role: "user",
          content:
            `Fecha y hora actual: ${fmtWhen(now, tz)}.\n` +
            `Cuándo NO enviar: ${criteria}\n\n` +
            `Últimos mensajes (del más antiguo al más reciente):\n${lines.join("\n")}\n\n` +
            `Recordatorio que se enviaría:\n${row.body.slice(0, 600)}`,
        },
      ],
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), REVIEW_TIMEOUT_MS));
    const result = await Promise.race([call, timeout]);
    const parsed = result ? (parseJsonLoose(result.content ?? "") as { enviar?: unknown; motivo?: unknown } | null) : null;

    if (!parsed || typeof parsed.enviar !== "boolean") {
      await markReviewed(row, meta, "error");
      return { reviewed: false };
    }
    if (parsed.enviar) {
      await markReviewed(row, meta, "send");
      return { reviewed: true, send: true };
    }
    const reason = (typeof parsed.motivo === "string" ? parsed.motivo : "").replace(/\s+/g, " ").trim().slice(0, 160).replace(/[.\s]+$/, "") || "la conversación indica que no conviene";
    await prisma.scheduledMessage.update({
      where: { id: row.id },
      data: {
        status: ScheduledMessageStatus.CANCELLED,
        sentAt: null,
        failureReason: `${AI_SKIP_PREFIX}: ${reason}`,
        metadata: { ...meta, aiReviewAt: Date.now(), aiVerdict: "skip" } as Prisma.InputJsonValue,
      },
    });
    return { reviewed: true, send: false, reason };
  } catch (err) {
    console.warn("[scheduler] revisión IA falló; el recordatorio se envía:", err instanceof Error ? err.message : err);
    return { reviewed: false };
  }
}

/** Deja la marca del contador en la fila (best-effort). */
async function markReviewed(row: ReviewRow, meta: Record<string, unknown>, verdict: "send" | "error"): Promise<void> {
  await prisma.scheduledMessage
    .update({
      where: { id: row.id },
      data: { metadata: { ...meta, aiReviewAt: Date.now(), aiVerdict: verdict } as Prisma.InputJsonValue },
    })
    .catch(() => undefined);
}
