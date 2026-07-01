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
import { parseSendConfig } from "./campaigns.types";
import { runRecipientActions } from "./campaign-runner";

interface DriverState {
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const drivers = new Map<string, DriverState>();

function emitProgress(
  companyId: string,
  campaignId: string,
  data: { status: string; totalCount: number; sentCount: number; failedCount: number; currentPhone?: string | null },
): void {
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CAMPAIGN_PROGRESS, {
    campaignId,
    ...data,
  });
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
      .update({ where: { id: campaignId }, data: { status: "COMPLETED", completedAt: new Date() } })
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
  if (fresh) {
    emitProgress(companyId, campaignId, {
      status: fresh.status,
      totalCount: fresh.totalCount,
      sentCount: fresh.sentCount,
      failedCount: fresh.failedCount,
      currentPhone: next.phone,
    });
  }

  // Si pausaron/cancelaron mientras procesábamos, no agendar el siguiente.
  if (fresh && fresh.status !== "RUNNING") {
    drivers.delete(campaignId);
    return;
  }

  const processed = (fresh?.sentCount ?? 0) + (fresh?.failedCount ?? 0);
  const isPausePoint = cfg.pauseEvery > 0 && processed > 0 && processed % cfg.pauseEvery === 0;
  const delayMs = (isPausePoint ? cfg.pauseSec : cfg.intervalSec) * 1000;
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
