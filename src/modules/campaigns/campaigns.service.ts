/**
 * Lógica de campañas masivas: CRUD, materialización de destinatarios, control de
 * ejecución (start/pause/resume/cancel), prueba y fuentes de audiencia.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import {
  DEFAULT_SEND_CONFIG,
  parseActions,
  parseAudience,
  parseSendConfig,
  type AudienceRecipient,
} from "./campaigns.types";
import { startDriver, stopDriver, resumeRunningCampaigns } from "./campaign-driver";
import { runRecipientActions } from "./campaign-runner";

export { resumeRunningCampaigns };

function digitsOf(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function listCampaigns(companyId: string) {
  const rows = await prisma.campaign.findMany({
    where: { companyId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      actions: true,
      totalCount: true,
      sentCount: true,
      failedCount: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { recipients: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    actionCount: parseActions(c.actions).length,
    recipientCount: c._count.recipients,
    totalCount: c.totalCount,
    sentCount: c.sentCount,
    failedCount: c.failedCount,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
}

export async function getCampaign(companyId: string, id: string) {
  const c = await prisma.campaign.findFirst({
    where: { id, companyId },
  });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    actions: parseActions(c.actions),
    sendConfig: parseSendConfig(c.sendConfig),
    audience: parseAudience(c.audience),
    contextProductId: c.contextProductId,
    contextTagIds: c.contextTagIds ?? [],
    contextRemoveTagIds: c.contextRemoveTagIds ?? [],
    totalCount: c.totalCount,
    sentCount: c.sentCount,
    failedCount: c.failedCount,
    nextSendAt: c.nextSendAt,
    pauseReason: c.pauseReason,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function listRecipients(companyId: string, id: string) {
  await ensureCampaign(companyId, id);
  return prisma.campaignRecipient.findMany({
    where: { campaignId: id },
    orderBy: { sortOrder: "asc" },
    select: { id: true, phone: true, name: true, status: true, sentAt: true, error: true },
  });
}

/** Contactos guardados del tenant (con sus etiquetas) para el paso de audiencia. */
export async function listContacts(companyId: string) {
  const rows = await prisma.customer.findMany({
    // Excluye visitantes anónimos del chat web (phone sintético "web:…"): no
    // tienen WhatsApp adonde enviar la campaña.
    where: { companyId, NOT: { phone: { startsWith: "web:" } } },
    orderBy: { lastInteractionAt: "desc" },
    take: 5000,
    select: {
      id: true,
      phone: true,
      name: true,
      tagLinks: { select: { tagId: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    phone: c.phone,
    name: c.name,
    tagIds: c.tagLinks.map((t) => t.tagId),
  }));
}

// ---------------------------------------------------------------------------
// Escrituras / CRUD
// ---------------------------------------------------------------------------

async function ensureCampaign(companyId: string, id: string) {
  const c = await prisma.campaign.findFirst({ where: { id, companyId } });
  if (!c) throw new AppError("Campaña no encontrada", 404);
  return c;
}

export async function createCampaign(companyId: string, data: { name: string }) {
  const c = await prisma.campaign.create({
    data: {
      companyId,
      name: data.name,
      status: "DRAFT",
      actions: [],
      sendConfig: DEFAULT_SEND_CONFIG as unknown as Prisma.InputJsonValue,
      audience: { recipients: [] },
    },
    select: { id: true },
  });
  return getCampaign(companyId, c.id);
}

export async function updateCampaign(
  companyId: string,
  id: string,
  data: {
    name?: string;
    actions?: unknown;
    sendConfig?: unknown;
    audience?: unknown;
    contextProductId?: string | null;
    contextTagIds?: string[];
    contextRemoveTagIds?: string[];
  },
) {
  const existing = await ensureCampaign(companyId, id);

  // Una vez lanzada (no DRAFT), solo se permite renombrar.
  const editingContent =
    data.actions !== undefined ||
    data.sendConfig !== undefined ||
    data.audience !== undefined ||
    data.contextProductId !== undefined ||
    data.contextTagIds !== undefined ||
    data.contextRemoveTagIds !== undefined;
  if (editingContent && existing.status !== "DRAFT") {
    throw new AppError("Solo puedes editar el contenido de una campaña en borrador", 409);
  }

  const patch: Prisma.CampaignUpdateInput = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.actions !== undefined) patch.actions = data.actions as Prisma.InputJsonValue;
  if (data.sendConfig !== undefined) patch.sendConfig = data.sendConfig as Prisma.InputJsonValue;
  if (data.audience !== undefined) patch.audience = data.audience as Prisma.InputJsonValue;
  if (data.contextProductId !== undefined) patch.contextProductId = data.contextProductId;
  if (data.contextTagIds !== undefined) patch.contextTagIds = data.contextTagIds;
  if (data.contextRemoveTagIds !== undefined) patch.contextRemoveTagIds = data.contextRemoveTagIds;

  await prisma.campaign.update({ where: { id }, data: patch });
  return getCampaign(companyId, id);
}

export async function deleteCampaign(companyId: string, id: string) {
  await ensureCampaign(companyId, id);
  stopDriver(id);
  await prisma.campaign.delete({ where: { id } });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Control de ejecución
// ---------------------------------------------------------------------------

/** Dígitos excluidos por motivo (para contar y explicar en la previsualización). */
export interface ExclusionSets {
  /** Pidieron no ser contactados (Customer.optOutAt): se excluyen SIEMPRE. */
  optOut: Set<string>;
  /** En atención humana (mutedNumbers / botPaused): solo cuando excludeMuted. */
  muted: Set<string>;
}

/**
 * Construye los dígitos a excluir. Los clientes que pidieron NO ser contactados
 * se excluyen SIEMPRE; los de atención humana solo cuando excludeMuted.
 */
export async function buildExclusionSets(companyId: string, excludeMuted: boolean): Promise<ExclusionSets> {
  const optOut = new Set<string>();
  const muted = new Set<string>();
  const optedOut = await prisma.customer.findMany({
    where: { companyId, optOutAt: { not: null } },
    select: { phone: true },
  });
  for (const c of optedOut) optOut.add(digitsOf(c.phone));
  if (!excludeMuted) return { optOut, muted };
  const cfg = await prisma.agentConfig.findUnique({
    where: { companyId },
    select: { mutedNumbers: true },
  });
  if (Array.isArray(cfg?.mutedNumbers)) {
    for (const n of cfg!.mutedNumbers as unknown[]) {
      if (typeof n === "string") muted.add(digitsOf(n));
    }
  }
  const paused = await prisma.conversation.findMany({
    where: { companyId, botPaused: true, channel: "whatsapp" },
    select: { customer: { select: { phone: true } } },
  });
  for (const p of paused) muted.add(digitsOf(p.customer.phone));
  return { optOut, muted };
}

/**
 * Aplica dedupe por dígitos + exclusiones a una audiencia y cuenta cuántos se
 * quedaron fuera y por qué. Compartido por startCampaign y la previsualización
 * del copiloto, así los dos ven exactamente la misma lista final.
 */
export function filterAudience(
  recipients: AudienceRecipient[],
  exclusions: ExclusionSets,
): { recipients: AudienceRecipient[]; excluded: { optOut: number; muted: number; duplicates: number; invalid: number } } {
  const seen = new Set<string>();
  const out: AudienceRecipient[] = [];
  const excluded = { optOut: 0, muted: 0, duplicates: 0, invalid: 0 };
  for (const r of recipients) {
    const d = String(r.phone ?? "").startsWith("web:") ? "" : digitsOf(r.phone); // visitante web sin WhatsApp
    if (d.length < 8) { excluded.invalid++; continue; }
    if (seen.has(d)) { excluded.duplicates++; continue; }
    seen.add(d);
    if (exclusions.optOut.has(d)) { excluded.optOut++; continue; }
    if (exclusions.muted.has(d)) { excluded.muted++; continue; }
    out.push(r);
  }
  return { recipients: out, excluded };
}

/**
 * Una sola campaña en curso por negocio: es el mismo número de WhatsApp y dos
 * drivers a la vez duplican el ritmo configurado. Devuelve la que corre (si hay).
 */
async function findOtherRunning(companyId: string, exceptId: string) {
  return prisma.campaign.findFirst({
    where: { companyId, status: "RUNNING", NOT: { id: exceptId } },
    select: { id: true, name: true },
  });
}

export async function startCampaign(companyId: string, id: string) {
  const campaign = await ensureCampaign(companyId, id);
  if (campaign.status !== "DRAFT") {
    throw new AppError("La campaña ya fue lanzada", 409);
  }
  const actions = parseActions(campaign.actions);
  if (!actions.length) throw new AppError("Agrega al menos una acción antes de lanzar", 400);

  const audience = parseAudience(campaign.audience);
  if (!audience.recipients.length) throw new AppError("Selecciona al menos un destinatario", 400);

  const other = await findOtherRunning(companyId, id);
  if (other) {
    throw new AppError(`Ya hay una campaña en curso («${other.name}»). Espera a que termine o pásala a pausa antes de lanzar otra`, 409);
  }

  const cfg = parseSendConfig(campaign.sendConfig);
  const { recipients: finalRecipients } = filterAudience(
    audience.recipients,
    await buildExclusionSets(companyId, cfg.excludeMuted),
  );
  if (!finalRecipients.length) {
    throw new AppError("No quedaron destinatarios válidos tras aplicar los filtros", 400);
  }

  await prisma.$transaction(async (tx) => {
    await tx.campaignRecipient.deleteMany({ where: { campaignId: id } });
    await tx.campaignRecipient.createMany({
      data: finalRecipients.map((r, idx) => ({
        companyId,
        campaignId: id,
        customerId: r.customerId ?? null,
        phone: r.phone,
        name: r.name ?? null,
        sortOrder: idx,
      })),
    });
    await tx.campaign.update({
      where: { id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        completedAt: null,
        totalCount: finalRecipients.length,
        sentCount: 0,
        failedCount: 0,
      },
    });
  });

  startDriver(companyId, id);
  return getCampaign(companyId, id);
}

export async function pauseCampaign(companyId: string, id: string) {
  const campaign = await ensureCampaign(companyId, id);
  if (campaign.status !== "RUNNING") throw new AppError("La campaña no está en ejecución", 409);
  stopDriver(id);
  await prisma.campaign.update({
    where: { id },
    data: { status: "PAUSED", nextSendAt: null, pauseReason: null },
  });
  return getCampaign(companyId, id);
}

export async function resumeCampaign(companyId: string, id: string) {
  const campaign = await ensureCampaign(companyId, id);
  if (campaign.status !== "PAUSED") throw new AppError("La campaña no está pausada", 409);
  const other = await findOtherRunning(companyId, id);
  if (other) {
    throw new AppError(`Ya hay una campaña en curso («${other.name}»). Espera a que termine o pásala a pausa antes de continuar esta`, 409);
  }
  // Recupera destinatarios que quedaron a medias (SENDING) → PENDING.
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: id, status: "SENDING" },
    data: { status: "PENDING" },
  });
  await prisma.campaign.update({ where: { id }, data: { status: "RUNNING", pauseReason: null } });
  startDriver(companyId, id);
  return getCampaign(companyId, id);
}

export async function cancelCampaign(companyId: string, id: string) {
  const campaign = await ensureCampaign(companyId, id);
  if (campaign.status !== "RUNNING" && campaign.status !== "PAUSED") {
    throw new AppError("Solo puedes cancelar una campaña en ejecución o pausada", 409);
  }
  stopDriver(id);
  await prisma.campaign.update({
    where: { id },
    data: { status: "CANCELLED", completedAt: new Date(), nextSendAt: null, pauseReason: null },
  });
  return getCampaign(companyId, id);
}

/**
 * Ejecuta la secuencia de acciones UNA vez contra un teléfono de prueba (el dueño),
 * sin crear destinatarios ni cambiar el estado de la campaña ("Ejecutar prueba para mí").
 */
export async function testCampaign(
  companyId: string,
  id: string,
  phone: string,
  name?: string,
) {
  const campaign = await ensureCampaign(companyId, id);
  const actions = parseActions(campaign.actions);
  if (!actions.length) throw new AppError("Agrega al menos una acción para probar", 400);
  await runRecipientActions(
    companyId,
    {
      id: campaign.id,
      name: campaign.name,
      actions: campaign.actions,
      contextProductId: campaign.contextProductId,
      contextTagIds: campaign.contextTagIds ?? [],
      contextRemoveTagIds: campaign.contextRemoveTagIds ?? [],
      metaTemplate: parseSendConfig(campaign.sendConfig).metaTemplate,
    },
    { phone, name: name ?? null },
    { persist: false },
  );
  return { success: true };
}
