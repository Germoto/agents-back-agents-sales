/**
 * Cuota de la IA DE PRUEBA de la plataforma. Las cuentas auto-activadas pueden
 * nacer con la key de FlowApp (AgentConfig.aiKeySource = PLATFORM) y un tope de
 * respuestas de IA por cliente (platformAiCap o el global de PlatformConfig).
 * Se cuentan las respuestas del agente a clientes y los mensajes del Copiloto.
 * Al agotarse, el agente deja de responder y el dueño recibe un aviso para
 * poner su propia key (con la key propia no hay tope).
 */
import { prisma } from "../../lib/prisma";
import { getTrialAiMessageCap } from "../platform-config/platform-config.service";
import { notifyOwner } from "./conversation.service";

export type PlatformAiQuota = {
  source: "OWN" | "PLATFORM";
  used: number;
  /** Tope vigente (override del cliente o global). null si la key es propia. */
  cap: number | null;
  exhausted: boolean;
};

export async function getPlatformAiQuota(companyId: string): Promise<PlatformAiQuota> {
  const row = await prisma.agentConfig.findUnique({
    where: { companyId },
    select: { aiKeySource: true, platformAiUsed: true, platformAiCap: true },
  });
  if (!row || row.aiKeySource !== "PLATFORM") return { source: "OWN", used: row?.platformAiUsed ?? 0, cap: null, exhausted: false };
  const cap = row.platformAiCap ?? (await getTrialAiMessageCap());
  return { source: "PLATFORM", used: row.platformAiUsed, cap, exhausted: row.platformAiUsed >= cap };
}

/** Suma una respuesta de IA al contador (solo si la key es de la plataforma). */
export async function consumePlatformAi(companyId: string): Promise<void> {
  await prisma.agentConfig.updateMany({
    where: { companyId, aiKeySource: "PLATFORM" },
    data: { platformAiUsed: { increment: 1 } },
  });
}

// Aviso al dueño una vez cada 24 h por empresa (en memoria; repetirlo tras un reinicio es aceptable).
const WARN_MS = 24 * 60 * 60 * 1000;
const warnedAt = new Map<string, number>();

export function platformAiExhaustedMessage(cap: number | null): string {
  return (
    `🤖 Se acabaron los ${cap ?? ""} mensajes de prueba de la IA de FlowApp y tu agente dejó de responder. ` +
    `Agrega tu propia API key en Agente IA → Modelo (sin tope) para que siga atendiendo.`
  );
}

export async function warnPlatformAiExhausted(companyId: string, quota: PlatformAiQuota): Promise<void> {
  const last = warnedAt.get(companyId) ?? 0;
  if (Date.now() - last < WARN_MS) return;
  warnedAt.set(companyId, Date.now());
  await notifyOwner(companyId, platformAiExhaustedMessage(quota.cap)).catch(() => undefined);
}
