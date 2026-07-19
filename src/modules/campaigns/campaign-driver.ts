/**
 * Motor de envío de campañas masivas.
 *
 * Paceo en memoria (Map + setTimeout, como el debounce del agente) combinado con
 * el claim optimista del scheduler (updateMany PENDING→SENDING) para idempotencia.
 * Procesa UN destinatario por tick respetando intervalSec y la pausa automática
 * cada N envíos. Single-instance: un reinicio se recupera vía resumeRunningCampaigns().
 */

import { prisma } from "../../lib/prisma";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { parseSendConfig, type CampaignSendConfig } from "./campaigns.types";
import { runRecipientActions } from "./campaign-runner";

interface DriverState {
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const drivers = new Map<string, DriverState>();

/** Motivo de la espera actual (se persiste en Campaign.pauseReason y va en el socket). */
type PauseReason = "auto" | "daily-limit" | "schedule";

function emitProgress(
  companyId: string,
  campaignId: string,
  data: {
    status: string;
    totalCount: number;
    sentCount: number;
    failedCount: number;
    currentPhone?: string | null;
    /** ISO de cuándo se procesa el próximo contacto (countdown en la UI). */
    nextAt?: string | null;
    pauseReason?: PauseReason | null;
  },
): void {
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CAMPAIGN_PROGRESS, {
    campaignId,
    ...data,
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Medianoche de HOY en la zona horaria del negocio (mismo patrón que flow-engine). */
function startOfTodayInTz(tz: string): Date {
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [y, m, d] = fmt.format(now).split("-").map(Number);
    const utcGuess = new Date(Date.UTC(y, m - 1, d));
    const tzDate = new Date(utcGuess.toLocaleString("en-US", { timeZone: tz }));
    const offset = tzDate.getTime() - utcGuess.getTime();
    return new Date(utcGuess.getTime() - offset);
  } catch {
    const local = new Date(now);
    local.setHours(0, 0, 0, 0);
    return local;
  }
}

/** Hoy a las HH:mm en la zona horaria del negocio. */
function todayAtInTz(tz: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(startOfTodayInTz(tz).getTime() + h * 3_600_000 + m * 60_000);
}

/**
 * Gates anti-ban: horario de envío y límite diario. Se evalúan antes de tomar
 * el siguiente destinatario; si bloquean, la campaña espera hasta `resumeAt`.
 */
async function checkSendGate(
  campaignId: string,
  cfg: CampaignSendConfig,
  tz: string,
): Promise<{ allowed: true } | { allowed: false; resumeAt: Date; reason: PauseReason }> {
  const now = Date.now();

  if (cfg.sendFrom && cfg.sendUntil) {
    const from = todayAtInTz(tz, cfg.sendFrom).getTime();
    const until = todayAtInTz(tz, cfg.sendUntil).getTime();
    if (from < until) {
      if (now < from) return { allowed: false, resumeAt: new Date(from), reason: "schedule" };
      if (now >= until) return { allowed: false, resumeAt: new Date(from + DAY_MS), reason: "schedule" };
    } else {
      // Ventana nocturna (ej. 20:00 → 02:00): bloqueado solo entre until y from
      if (now >= until && now < from) return { allowed: false, resumeAt: new Date(from), reason: "schedule" };
    }
  }

  if (cfg.dailyLimit > 0) {
    const sentToday = await prisma.campaignRecipient.count({
      where: { campaignId, status: "SENT", sentAt: { gte: startOfTodayInTz(tz) } },
    });
    if (sentToday >= cfg.dailyLimit) {
      const midnight = startOfTodayInTz(tz).getTime() + DAY_MS;
      let resumeAt = new Date(midnight);
      if (cfg.sendFrom) {
        const nextFrom = todayAtInTz(tz, cfg.sendFrom).getTime() + DAY_MS;
        if (nextFrom > midnight) resumeAt = new Date(nextFrom);
      }
      return { allowed: false, resumeAt, reason: "daily-limit" };
    }
  }

  return { allowed: true };
}

export function isDriverRunning(campaignId: string): boolean {
  return drivers.has(campaignId);
}

/** Arranca (o re-arranca) el driver de una campaña en estado RUNNING. */
export function startDriver(companyId: string, campaignId: string): void {
  if (drivers.has(campaignId)) return;
  const state: DriverState = { stopped: false };
  drivers.set(campaignId, state);
  void tick(companyId, campaignId);
}

/** Detiene el driver (pausa/cancelación). No toca el estado en BD. */
export function stopDriver(campaignId: string): void {
  const state = drivers.get(campaignId);
  if (!state) return;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  drivers.delete(campaignId);
}

function scheduleNext(companyId: string, campaignId: string, delayMs: number): void {
  const state = drivers.get(campaignId);
  if (!state || state.stopped) return;
  state.timer = setTimeout(() => void tick(companyId, campaignId), delayMs);
}

async function tick(companyId: string, campaignId: string): Promise<void> {
  const state = drivers.get(campaignId);
  if (!state || state.stopped) return;

  let campaign;
  try {
    campaign = await prisma.campaign.findFirst({
      where: { id: campaignId, companyId },
      select: { id: true, name: true, status: true, actions: true, sendConfig: true, contextProductId: true, contextTagIds: true, totalCount: true, sentCount: true, failedCount: true },
    });
  } catch (err) {
    console.error("[campaign] tick: error cargando campaña:", err instanceof Error ? err.message : err);
    scheduleNext(companyId, campaignId, 5000);
    return;
  }

  if (!campaign || campaign.status !== "RUNNING") {
    drivers.delete(campaignId);
    return;
  }

  const cfg = parseSendConfig(campaign.sendConfig);

  // Siguiente destinatario pendiente (orden estable por sortOrder).
  const next = await prisma.campaignRecipient.findFirst({
    where: { campaignId, status: "PENDING" },
    orderBy: { sortOrder: "asc" },
    select: { id: true, customerId: true, phone: true, name: true },
  });

  if (!next) {
    await prisma.campaign
      .update({
        where: { id: campaignId },
        data: { status: "COMPLETED", completedAt: new Date(), nextSendAt: null, pauseReason: null },
      })
      .catch(() => undefined);
    emitProgress(companyId, campaignId, {
      status: "COMPLETED",
      totalCount: campaign.totalCount,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
    });
    drivers.delete(campaignId);
    return;
  }

  // Gates anti-ban (horario / límite diario): esperar hasta resumeAt sin tomar el contacto.
  if ((cfg.sendFrom && cfg.sendUntil) || cfg.dailyLimit > 0) {
    const company = await prisma.company
      .findUnique({ where: { id: companyId }, select: { timezone: true } })
      .catch(() => null);
    const gate = await checkSendGate(campaignId, cfg, company?.timezone ?? "America/Lima");
    if (!gate.allowed) {
      await prisma.campaign
        .update({ where: { id: campaignId }, data: { nextSendAt: gate.resumeAt, pauseReason: gate.reason } })
        .catch(() => undefined);
      emitProgress(companyId, campaignId, {
        status: "RUNNING",
        totalCount: campaign.totalCount,
        sentCount: campaign.sentCount,
        failedCount: campaign.failedCount,
        nextAt: gate.resumeAt.toISOString(),
        pauseReason: gate.reason,
      });
      scheduleNext(companyId, campaignId, Math.max(1000, gate.resumeAt.getTime() - Date.now() + 1000));
      return;
    }
  }

  // Claim atómico: solo procede quien gana el UPDATE PENDING→SENDING.
  const claim = await prisma.campaignRecipient.updateMany({
    where: { id: next.id, status: "PENDING" },
    data: { status: "SENDING" },
  });
  if (claim.count === 0) {
    scheduleNext(companyId, campaignId, 0);
    return;
  }

  let ok = false;
  try {
    await runRecipientActions(
      companyId,
      {
        id: campaign.id,
        name: campaign.name,
        actions: campaign.actions,
        contextProductId: campaign.contextProductId,
        contextTagIds: campaign.contextTagIds ?? [],
        metaTemplate: cfg.metaTemplate,
      },
      { id: next.id, customerId: next.customerId, phone: next.phone, name: next.name },
      { persist: true },
    );
    ok = true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Error de envío";
    await prisma.campaignRecipient
      .update({ where: { id: next.id }, data: { status: "FAILED", error: reason.slice(0, 500) } })
      .catch(() => undefined);
    await prisma.campaign
      .update({ where: { id: campaignId }, data: { failedCount: { increment: 1 } } })
      .catch(() => undefined);
  }

  if (ok) {
    await prisma.campaignRecipient
      .update({ where: { id: next.id }, data: { status: "SENT", sentAt: new Date() } })
      .catch(() => undefined);
    await prisma.campaign
      .update({ where: { id: campaignId }, data: { sentCount: { increment: 1 } } })
      .catch(() => undefined);
  }

  const fresh = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, totalCount: true, sentCount: true, failedCount: true },
  });

  // Si pausaron/cancelaron mientras procesábamos, no agendar el siguiente.
  if (!fresh || fresh.status !== "RUNNING") {
    if (fresh) {
      emitProgress(companyId, campaignId, {
        status: fresh.status,
        totalCount: fresh.totalCount,
        sentCount: fresh.sentCount,
        failedCount: fresh.failedCount,
        currentPhone: next.phone,
      });
    }
    drivers.delete(campaignId);
    return;
  }

  const processed = fresh.sentCount + fresh.failedCount;
  const isPausePoint = cfg.pauseEvery > 0 && processed > 0 && processed % cfg.pauseEvery === 0;
  let delayMs = (isPausePoint ? cfg.pauseSec : cfg.intervalSec) * 1000;
  // Jitter anti-ban: ±25% para no enviar con tiempos exactos de robot.
  if (cfg.randomize && delayMs > 0) delayMs = Math.round(delayMs * (0.75 + Math.random() * 0.5));

  const nextAt = new Date(Date.now() + delayMs);
  const pauseReason: PauseReason | null = isPausePoint ? "auto" : null;
  await prisma.campaign
    .update({ where: { id: campaignId }, data: { nextSendAt: nextAt, pauseReason } })
    .catch(() => undefined);
  emitProgress(companyId, campaignId, {
    status: fresh.status,
    totalCount: fresh.totalCount,
    sentCount: fresh.sentCount,
    failedCount: fresh.failedCount,
    currentPhone: next.phone,
    nextAt: nextAt.toISOString(),
    pauseReason,
  });
  scheduleNext(companyId, campaignId, delayMs);
}

/**
 * Reanuda los drivers de todas las campañas que quedaron RUNNING (arranque del
 * servidor). Resetea destinatarios que quedaron SENDING (corte a mitad) a PENDING.
 */
export async function resumeRunningCampaigns(): Promise<void> {
  try {
    const running = await prisma.campaign.findMany({
      where: { status: "RUNNING" },
      select: { id: true, companyId: true },
    });
    for (const c of running) {
      await prisma.campaignRecipient
        .updateMany({ where: { campaignId: c.id, status: "SENDING" }, data: { status: "PENDING" } })
        .catch(() => undefined);
      startDriver(c.companyId, c.id);
    }
    if (running.length) console.log(`[campaign] reanudadas ${running.length} campañas en curso`);
  } catch (err) {
    console.error("[campaign] resumeRunningCampaigns falló:", err instanceof Error ? err.message : err);
  }
}
