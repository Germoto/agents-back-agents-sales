/**
 * Compuerta de los envíos manuales que hace el COPILOTO/MCP en nombre del asesor
 * (enviar_mensaje_cliente, enviar_respuesta_rapida, iniciar_conversacion).
 *
 * El asesor humano del panel no pasa por aquí (sigue libre). El copiloto sí,
 * porque puede correr sin supervisión (tareas programadas en claude.ai) y no
 * debe romper tres cosas:
 *   1. "No contactar": clientes con optOutAt nunca reciben nada.
 *   2. Ventana de 24 h de Meta: fuera de ella un mensaje libre falla (131047);
 *      SMS Tools y el chat web no tienen esa restricción.
 *   3. Ritmo anti-bloqueo: mismos valores que los recordatorios
 *      (followupConfig.pacing → 25–70 s entre clientes distintos, tope/hora),
 *      ×2 si hay una campaña enviando ahora. Solo cuenta mensajes ADMIN con
 *      rawPayload.source = "copilot", así no castiga al asesor humano ni al bot.
 */

import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { isWithin24hWindow } from "./session-window";
import { normalizePacing, pacingDelayMs } from "../scheduler/quiet-hours";

export const COPILOT_SOURCE = "copilot";

/** Espera máxima en proceso antes de responder "reintenta en N s" (la tool no puede colgarse). */
const MAX_WAIT_MS = 30_000;
const CAMPAIGN_ACTIVE_WINDOW_MS = 10 * 60_000;
const CAMPAIGN_PACING_FACTOR = 2;

export type ManualSendGateInput = {
  companyId: string;
  customerId: string | null;
  /** Proveedor del sender que va a usarse: "META" aplica la ventana de 24 h. */
  provider: "SMSTOOLS" | "META" | "WEB" | null;
  optOutAt?: Date | null;
};

export type ManualSendGateResult =
  | { ok: true; esperadoSeg: number; enviadosUltimaHora: number; topeHora: number }
  | { ok: false; error: string; nota?: string; reintentarEnSeg?: number };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Inyectable en tests (timers). */
export const gateInternals = { sleep, now: () => Date.now() };

export async function checkManualSendGate(input: ManualSendGateInput): Promise<ManualSendGateResult> {
  if (input.optOutAt) {
    return {
      ok: false,
      error: "el cliente pidió no ser contactado (noContactar)",
      nota: "Solo el dueño puede quitar la marca con actualizar_cliente {noContactar:false}; no la quites por iniciativa propia.",
    };
  }

  if (input.provider === "META" && input.customerId) {
    const open = await isWithin24hWindow(input.companyId, input.customerId);
    if (!open) {
      return {
        ok: false,
        error: "fuera de la ventana de 24 h de WhatsApp (Meta): el cliente no escribe hace más de 24 h",
        nota: "Un mensaje libre sería rechazado. Para reengancharlo usa programar_recordatorio_cliente (sale con la plantilla de respaldo del negocio) o una campaña con plantilla; cuando el cliente responda, podrás escribirle normal.",
      };
    }
  }

  const now = gateInternals.now();
  const hourAgo = new Date(now - 60 * 60_000);
  const [agentCfg, campaign, sentLastHour, lastOther] = await Promise.all([
    prisma.agentConfig.findUnique({ where: { companyId: input.companyId }, select: { followupConfig: true } }),
    prisma.campaign.findFirst({
      where: { companyId: input.companyId, status: "RUNNING", nextSendAt: { gte: new Date(now - CAMPAIGN_ACTIVE_WINDOW_MS) } },
      select: { id: true },
    }),
    prisma.conversationMessage.count({
      where: { companyId: input.companyId, role: "ADMIN", createdAt: { gte: hourAgo }, rawPayload: { path: ["source"], equals: COPILOT_SOURCE } },
    }),
    prisma.conversationMessage.findFirst({
      where: {
        companyId: input.companyId,
        role: "ADMIN",
        createdAt: { gte: hourAgo },
        rawPayload: { path: ["source"], equals: COPILOT_SOURCE },
        ...(input.customerId ? { customerId: { not: input.customerId } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const followup = agentCfg?.followupConfig as { pacing?: unknown } | null;
  const pacing = normalizePacing(followup?.pacing, {
    minSec: env.REMINDER_PACING_MIN_SEC,
    maxSec: env.REMINDER_PACING_MAX_SEC,
    maxPerHour: env.REMINDER_MAX_PER_HOUR,
  });
  const factor = campaign ? CAMPAIGN_PACING_FACTOR : 1;
  const topeHora = Math.max(1, Math.floor(pacing.maxPerHour / factor));

  if (sentLastHour >= topeHora) {
    return {
      ok: false,
      error: `tope anti-bloqueo alcanzado: ${sentLastHour} mensajes del copiloto en la última hora (máximo ${topeHora}${campaign ? ", reducido porque hay una campaña enviando" : ""})`,
      reintentarEnSeg: 15 * 60,
      nota: "Es el mismo ritmo de los recordatorios (configurar_recordatorios → pacing). Espera o pide al dueño que responda desde el panel.",
    };
  }

  // Separación al azar respecto del último envío del copiloto a OTRO cliente
  // (responder dos veces al mismo cliente no es ráfaga).
  let esperadoSeg = 0;
  if (lastOther) {
    const gapMs = pacingDelayMs(pacing, factor);
    const remaining = lastOther.createdAt.getTime() + gapMs - now;
    if (remaining > MAX_WAIT_MS) {
      const seg = Math.ceil(remaining / 1000);
      return {
        ok: false,
        error: `ritmo anti-bloqueo: el copiloto escribió a otro cliente hace poco; reintenta en ${seg} s`,
        reintentarEnSeg: seg,
      };
    }
    if (remaining > 0) {
      await gateInternals.sleep(remaining);
      esperadoSeg = Math.round(remaining / 1000);
    }
  }

  return { ok: true, esperadoSeg, enviadosUltimaHora: sentLastHour, topeHora };
}
