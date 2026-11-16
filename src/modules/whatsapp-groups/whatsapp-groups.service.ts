/**
 * Grupos de WhatsApp (solo gateway SMS Tools): grupos guardados del negocio y cola
 * de «agregar al cliente X al grupo Y». Nadie llama al gateway directo: todo pedido
 * (venta, botón, lote, flujo, agente, Copiloto) es una fila de WhatsappGroupMember.
 *
 * - Un contacto suelto (immediate) se intenta al momento, en segundo plano.
 * - Los lotes los despacha el worker respetando el ritmo anti-bloqueo del gateway:
 *   hasta 20 números por llamada y 10 a 15 minutos entre llamadas del mismo grupo.
 * - Un error de llamada (cuenta no admin, desconectada, gid inválido) pausa la cola
 *   del grupo y avisa al dueño una sola vez; no se queman reintentos.
 */

import { Prisma, WhatsappGroupAddSource, WhatsappGroupMemberStatus } from "@prisma/client";
import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";
import { smsTools, type SmsToolsGroupAddResult } from "../../lib/smstools-client";
import { notifyOwner, recordMessage } from "../agent/conversation.service";
import { PURCHASED_STORE_ORDER } from "../storefront/storefront-order.service";

export const GROUP_BATCH_SIZE = 20;
const BATCH_GAP_MIN_MS = 10 * 60_000;
const BATCH_GAP_MAX_MS = 15 * 60_000;
/** Tope de altas «al momento» por grupo y hora; el resto espera el ritmo de lote. */
const IMMEDIATE_HOURLY_CAP = 60;
const RETRY_DELAY_MS = 24 * 60 * 60_000;
const MAX_ATTEMPTS = 2;
const TRANSIENT_RETRY_MS = 5 * 60_000;
const STALE_CLAIM_MS = 10 * 60_000;

/** Estados en los que el cliente ya está (o ya fue invitado) y no hay nada que hacer. */
const SETTLED: WhatsappGroupMemberStatus[] = ["AGREGADO", "INVITADO", "YA_ESTABA"];
const IN_QUEUE: WhatsappGroupMemberStatus[] = ["PENDIENTE", "PROCESANDO"];

const processing = new Set<string>();

type Creds = { apiUrl: string; secret: string; account: string };

/** Credenciales del gateway si el canal del negocio es SMS Tools y está completo. */
async function loadGroupCreds(companyId: string): Promise<Creds | null> {
  const wa = await prisma.whatsappConfig.findUnique({
    where: { companyId },
    select: { provider: true, apiUrl: true, secret: true, account: true, provisionPending: true },
  });
  if (!wa || wa.provider !== "SMSTOOLS" || wa.provisionPending || !wa.apiUrl || !wa.secret || !wa.account) return null;
  return { apiUrl: wa.apiUrl, secret: wa.secret, account: wa.account };
}

async function requireGroupCreds(companyId: string): Promise<Creds> {
  const creds = await loadGroupCreds(companyId);
  if (!creds) {
    throw new AppError("Los grupos de WhatsApp solo funcionan con el canal SMS Tools conectado.", 400);
  }
  return creds;
}

export async function groupsSupported(companyId: string): Promise<boolean> {
  return (await loadGroupCreds(companyId)) !== null;
}

async function requireGroup(companyId: string, groupId: string) {
  const group = await prisma.whatsappGroup.findFirst({ where: { id: groupId, companyId } });
  if (!group) throw new AppError("Grupo no encontrado", 404);
  return group;
}

// ---------------------------------------------------------------------------
// Grupos guardados
// ---------------------------------------------------------------------------

type Counters = { agregados: number; invitados: number; pendientes: number; enEspera: number; fallidos: number };

function emptyCounters(): Counters {
  return { agregados: 0, invitados: 0, pendientes: 0, enEspera: 0, fallidos: 0 };
}

function addCount(c: Counters, status: WhatsappGroupMemberStatus, n: number) {
  if (status === "AGREGADO" || status === "YA_ESTABA") c.agregados += n;
  else if (status === "INVITADO") c.invitados += n;
  else if (status === "PENDIENTE" || status === "PROCESANDO") c.pendientes += n;
  else if (status === "EN_ESPERA") c.enEspera += n;
  else if (status === "FALLIDO") c.fallidos += n;
}

/** Minutos aproximados para vaciar una cola de `pending` números al ritmo de lote. */
export function estimateMinutes(pending: number): number {
  if (pending <= 0) return 0;
  const batches = Math.ceil(pending / GROUP_BATCH_SIZE);
  return Math.round(((batches - 1) * (BATCH_GAP_MIN_MS + BATCH_GAP_MAX_MS)) / 2 / 60_000);
}

export async function listSavedGroups(companyId: string) {
  const [supported, groups, counts] = await Promise.all([
    groupsSupported(companyId),
    prisma.whatsappGroup.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
    prisma.whatsappGroupMember.groupBy({ by: ["groupId", "status"], where: { companyId }, _count: { _all: true } }),
  ]);
  const byGroup = new Map<string, Counters>();
  for (const row of counts) {
    const c = byGroup.get(row.groupId) ?? emptyCounters();
    addCount(c, row.status, row._count._all);
    byGroup.set(row.groupId, c);
  }
  return {
    supported,
    groups: groups.map((g) => {
      const counters = byGroup.get(g.id) ?? emptyCounters();
      return {
        id: g.id,
        gid: g.gid,
        name: g.name,
        pausedReason: g.pausedReason,
        pausedAt: g.pausedAt,
        nextBatchAt: g.nextBatchAt,
        counters,
        etaMinutes: estimateMinutes(counters.pendientes),
      };
    }),
  };
}

/** Grupos de la cuenta en vivo, marcando cuáles ya están guardados. */
export async function listAvailableGroups(companyId: string) {
  const creds = await requireGroupCreds(companyId);
  const [live, saved] = await Promise.all([
    smsTools.getGroups(creds, creds.account),
    prisma.whatsappGroup.findMany({ where: { companyId }, select: { id: true, gid: true } }),
  ]);
  const savedByGid = new Map(saved.map((g) => [g.gid, g.id]));
  return live.map((g) => ({ gid: g.gid, name: g.name, savedId: savedByGid.get(g.gid) ?? null }));
}

export async function saveGroup(companyId: string, data: { gid: string; name: string }) {
  await requireGroupCreds(companyId);
  return prisma.whatsappGroup.upsert({
    where: { companyId_gid: { companyId, gid: data.gid } },
    create: { companyId, gid: data.gid, name: data.name },
    update: { name: data.name },
  });
}

export async function removeGroup(companyId: string, groupId: string) {
  await requireGroup(companyId, groupId);
  await prisma.whatsappGroup.delete({ where: { id: groupId } });
}

export async function resumeGroup(companyId: string, groupId: string) {
  await requireGroup(companyId, groupId);
  return prisma.whatsappGroup.update({
    where: { id: groupId },
    data: { pausedReason: null, pausedAt: null, nextBatchAt: null },
  });
}

// ---------------------------------------------------------------------------
// Miembros
// ---------------------------------------------------------------------------

const STATUS_FILTERS: Record<string, WhatsappGroupMemberStatus[]> = {
  agregados: ["AGREGADO", "YA_ESTABA"],
  invitados: ["INVITADO"],
  pendientes: ["PENDIENTE", "PROCESANDO"],
  enEspera: ["EN_ESPERA"],
  fallidos: ["FALLIDO"],
  cancelados: ["CANCELADO"],
};

export type MemberFilter = keyof typeof STATUS_FILTERS;

export async function listMembers(
  companyId: string,
  groupId: string,
  opts: { filter?: string; search?: string; page: number; pageSize: number },
) {
  await requireGroup(companyId, groupId);
  const search = opts.search?.trim();
  const where: Prisma.WhatsappGroupMemberWhereInput = {
    companyId,
    groupId,
    ...(opts.filter && STATUS_FILTERS[opts.filter] ? { status: { in: STATUS_FILTERS[opts.filter] } } : {}),
    ...(search
      ? {
          OR: [
            { phone: { contains: search.replace(/\D/g, "") || search } },
            { customer: { name: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.whatsappGroupMember.count({ where }),
    prisma.whatsappGroupMember.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: { customer: { select: { id: true, name: true, phone: true, waIsLid: true } } },
    }),
  ]);
  return {
    total,
    page: opts.page,
    pageSize: opts.pageSize,
    items: rows.map((m) => ({
      id: m.id,
      customerId: m.customerId,
      name: m.customer.name,
      phone: m.customer.waIsLid ? null : m.customer.phone,
      status: m.status,
      source: m.source,
      attempts: m.attempts,
      lastResult: m.lastResult,
      lastCode: m.lastCode,
      nextAttemptAt: m.nextAttemptAt,
      resolvedAt: m.resolvedAt,
      createdAt: m.createdAt,
    })),
  };
}

/** Grupos de un contacto (chips de la pestaña Contacto). */
export async function listCustomerGroups(companyId: string, customerId: string) {
  const rows = await prisma.whatsappGroupMember.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "asc" },
    include: { group: { select: { id: true, name: true } } },
  });
  return rows.map((m) => ({
    memberId: m.id,
    groupId: m.groupId,
    groupName: m.group.name,
    status: m.status,
    lastResult: m.lastResult,
    updatedAt: m.updatedAt,
  }));
}

export async function retryMembers(companyId: string, groupId: string, memberIds?: string[]) {
  await requireGroup(companyId, groupId);
  const res = await prisma.whatsappGroupMember.updateMany({
    where: {
      companyId,
      groupId,
      status: { in: ["FALLIDO", "EN_ESPERA", "CANCELADO"] },
      ...(memberIds?.length ? { id: { in: memberIds } } : { status: "FALLIDO" }),
    },
    data: { status: "PENDIENTE", attempts: 0, nextAttemptAt: new Date(), immediate: false, recheck: false },
  });
  return { requeued: res.count };
}

export async function cancelPending(companyId: string, groupId: string) {
  await requireGroup(companyId, groupId);
  // Los que solo se estaban re-consultando vuelven a «invitado»; el resto se cancela.
  const back = await prisma.whatsappGroupMember.updateMany({
    where: { companyId, groupId, status: "PENDIENTE", recheck: true },
    data: { status: "INVITADO", recheck: false },
  });
  const res = await prisma.whatsappGroupMember.updateMany({
    where: { companyId, groupId, status: "PENDIENTE" },
    data: { status: "CANCELADO", resolvedAt: new Date() },
  });
  return { cancelled: res.count, restored: back.count };
}

/**
 * «Actualizar estado»: el gateway no avisa cuando un invitado acepta. Se vuelve a
 * consultar a los invitados con invite=0 (no reenvía la invitación): quien ya entró
 * responde already_in. Va por la cola, con el mismo ritmo de lote.
 */
export async function refreshInvited(companyId: string, groupId: string) {
  await requireGroup(companyId, groupId);
  const res = await prisma.whatsappGroupMember.updateMany({
    where: { companyId, groupId, status: "INVITADO" },
    data: { status: "PENDIENTE", recheck: true, immediate: false, nextAttemptAt: new Date() },
  });
  return { queued: res.count, etaMinutes: estimateMinutes(res.count) };
}

// ---------------------------------------------------------------------------
// Encolar
// ---------------------------------------------------------------------------

export type EnqueueResult = {
  total: number;
  queued: number;
  skipped: { yaEnGrupo: number; enCola: number; noContactar: number; sinWhatsapp: number; salioDelGrupo: number; noEncontrados: number };
  etaMinutes: number;
};

/**
 * Encola clientes para un grupo. Omite visitantes web, «No contactar», los que ya
 * están o ya fueron invitados y los que ya esperan en la cola. `dryRun` solo cuenta.
 * `immediate` (un contacto suelto) dispara el intento en segundo plano.
 */
export async function enqueueGroupAdd(opts: {
  companyId: string;
  groupId: string;
  customerIds: string[];
  source: WhatsappGroupAddSource;
  immediate?: boolean;
  dryRun?: boolean;
  /** Pedido explícito del dueño sobre un contacto: reintenta aunque haya salido del grupo. */
  force?: boolean;
}): Promise<EnqueueResult> {
  const { companyId, groupId, source } = opts;
  await requireGroup(companyId, groupId);
  await requireGroupCreds(companyId);

  const ids = [...new Set(opts.customerIds)];
  const [customers, existing] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, phone: true, optOutAt: true },
    }),
    prisma.whatsappGroupMember.findMany({
      where: { groupId, customerId: { in: ids } },
      select: { customerId: true, status: true },
    }),
  ]);
  const existingBy = new Map(existing.map((m) => [m.customerId, m.status]));
  const skipped = { yaEnGrupo: 0, enCola: 0, noContactar: 0, sinWhatsapp: 0, salioDelGrupo: 0, noEncontrados: ids.length - customers.length };
  const toCreate: Prisma.WhatsappGroupMemberCreateManyInput[] = [];
  const toRequeue: string[] = [];
  const immediate = opts.immediate === true;

  for (const c of customers) {
    const digits = c.phone.replace(/\D/g, "");
    if (c.phone.startsWith("web:") || digits.length < 6) { skipped.sinWhatsapp += 1; continue; }
    if (c.optOutAt) { skipped.noContactar += 1; continue; }
    const prev = existingBy.get(c.id);
    if (prev && SETTLED.includes(prev)) { skipped.yaEnGrupo += 1; continue; }
    if (prev && IN_QUEUE.includes(prev)) { skipped.enCola += 1; continue; }
    if (prev === "EN_ESPERA" && !opts.force) { skipped.salioDelGrupo += 1; continue; }
    if (prev) toRequeue.push(c.id);
    else toCreate.push({ companyId, groupId, customerId: c.id, phone: digits, source, immediate });
  }

  const queued = toCreate.length + toRequeue.length;
  if (!opts.dryRun && queued > 0) {
    if (toCreate.length) await prisma.whatsappGroupMember.createMany({ data: toCreate, skipDuplicates: true });
    if (toRequeue.length) {
      await prisma.whatsappGroupMember.updateMany({
        where: { groupId, customerId: { in: toRequeue }, status: { in: ["FALLIDO", "CANCELADO", "EN_ESPERA"] } },
        data: { status: "PENDIENTE", source, attempts: 0, nextAttemptAt: new Date(), immediate, recheck: false, resolvedAt: null },
      });
    }
    if (immediate) {
      void processGroup(groupId, "immediate").catch((err) =>
        console.error("[wa-groups] intento inmediato falló:", err instanceof Error ? err.message : err),
      );
    }
  }
  return { total: ids.length, queued, skipped, etaMinutes: immediate ? 0 : estimateMinutes(queued) };
}

/**
 * Alta automática (venta, presentación, cobro, flujo, agente): best-effort, nunca
 * lanza ni frena la entrega. Devuelve si quedó encolado.
 */
export async function autoGroupAdd(
  companyId: string,
  groupId: string | null | undefined,
  customerId: string,
  source: WhatsappGroupAddSource,
): Promise<{ ok: boolean; reason?: string; groupName?: string }> {
  if (!groupId) return { ok: false, reason: "sin_grupo" };
  try {
    const group = await prisma.whatsappGroup.findFirst({ where: { id: groupId, companyId }, select: { name: true } });
    if (!group) return { ok: false, reason: "grupo_no_existe" };
    const res = await enqueueGroupAdd({ companyId, groupId, customerIds: [customerId], source, immediate: true });
    if (res.queued > 0) return { ok: true, groupName: group.name };
    const reason = res.skipped.yaEnGrupo || res.skipped.enCola
      ? "ya_estaba"
      : res.skipped.noContactar
        ? "no_contactar"
        : res.skipped.salioDelGrupo
          ? "salio_del_grupo"
          : "sin_whatsapp";
    return { ok: reason === "ya_estaba", reason, groupName: group.name };
  } catch (err) {
    console.warn("[wa-groups] alta automática omitida:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "no_disponible" };
  }
}

/** Compradores de un producto: entregas digitales, comprobantes aprobados, pedidos y tienda web. */
export async function resolveBuyers(companyId: string, productId: string): Promise<string[]> {
  const [sales, receipts, orders, storeOrders] = await Promise.all([
    prisma.digitalSale.findMany({
      where: { companyId, productId, status: "ENTREGADO" },
      select: { customerId: true },
      distinct: ["customerId"],
    }),
    prisma.paymentReceipt.findMany({
      where: { companyId, status: "APROBADO", customerId: { not: null }, OR: [{ productId }, { productIds: { has: productId } }] },
      select: { customerId: true },
      distinct: ["customerId"],
    }),
    prisma.order.findMany({
      where: {
        companyId,
        AND: [
          { OR: [{ productId }, { items: { some: { productId } } }] },
          {
            OR: [
              { status: { in: ["PAGADO", "DESPACHADO", "LISTO_PARA_RECOGER", "ENTREGADO"] } },
              { status: { not: "CANCELADO" }, paymentStatus: { in: ["PAGADO", "PAGO_PARCIAL"] } },
            ],
          },
        ],
      },
      select: { customerId: true },
      distinct: ["customerId"],
    }),
    prisma.storeOrder.findMany({
      where: { companyId, AND: [PURCHASED_STORE_ORDER, { OR: [{ productId }, { productIds: { has: productId } }] }] },
      select: { customerId: true },
      distinct: ["customerId"],
    }),
  ]);
  const out = new Set<string>();
  for (const r of [...sales, ...receipts, ...orders, ...storeOrders]) if (r.customerId) out.add(r.customerId);
  return [...out];
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

const RESULT_STATUS: Record<string, WhatsappGroupMemberStatus> = {
  added: "AGREGADO",
  invite_sent: "INVITADO",
  already_in: "YA_ESTABA",
  cooldown: "EN_ESPERA",
};

function randomGapMs(): number {
  return BATCH_GAP_MIN_MS + Math.floor(Math.random() * (BATCH_GAP_MAX_MS - BATCH_GAP_MIN_MS));
}

/** Estado del gateway dentro del AppError (envelope.status), si lo hay. */
function gatewayStatusOf(err: unknown): number | null {
  if (!(err instanceof AppError)) return null;
  const d = err.details as { status?: unknown } | null | undefined;
  return d && typeof d === "object" && typeof d.status === "number" ? d.status : null;
}

function pauseReasonFor(status: number, message: string): string {
  if (status === 401) return "La API key de SMS Tools no es válida.";
  if (status === 403) return "La API key de SMS Tools no tiene permiso de envío (wa_send).";
  if (status === 404) return "SMS Tools no encontró la cuenta de WhatsApp. Revisa que siga conectada.";
  if (status === 500) {
    return "WhatsApp no dejó agregar participantes. Lo más probable: tu número no es administrador del grupo, el grupo ya no existe o la cuenta está desconectada.";
  }
  return message || "El proveedor de WhatsApp rechazó la operación.";
}

async function noteInChat(companyId: string, customerId: string, text: string): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { companyId, customerId, channel: "whatsapp" },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (!conv) return;
  await recordMessage({
    companyId,
    customerId,
    conversationId: conv.id,
    role: "SYSTEM",
    message: text,
    rawPayload: { source: "wa-group" },
  }).catch(() => undefined);
}

/**
 * Despacha UNA llamada al gateway para el grupo. `immediate` toma solo los contactos
 * sueltos y no espera el ritmo; `batch` (worker) toma hasta 20 y agenda el siguiente
 * lote. Devuelve cuántos números se enviaron.
 */
export async function processGroup(groupId: string, mode: "immediate" | "batch"): Promise<number> {
  if (processing.has(groupId)) return 0;
  processing.add(groupId);
  try {
    const group = await prisma.whatsappGroup.findUnique({ where: { id: groupId } });
    if (!group || group.pausedReason) return 0;
    const now = new Date();
    if (mode === "batch" && group.nextBatchAt && group.nextBatchAt > now) return 0;
    const creds = await loadGroupCreds(group.companyId);
    if (!creds) return 0;

    if (mode === "immediate") {
      const recent = await prisma.whatsappGroupMember.count({
        where: { groupId, claimedAt: { gt: new Date(now.getTime() - 60 * 60_000) } },
      });
      if (recent >= IMMEDIATE_HOURLY_CAP) return 0; // lo toma el worker, a ritmo de lote
    }

    const base: Prisma.WhatsappGroupMemberWhereInput = { groupId, status: "PENDIENTE", nextAttemptAt: { lte: now } };
    // Altas reales primero; la re-consulta de invitados (invite=0) va en su propia llamada.
    let recheck = false;
    let rows = await prisma.whatsappGroupMember.findMany({
      where: { ...base, recheck: false, ...(mode === "immediate" ? { immediate: true } : {}) },
      orderBy: [{ immediate: "desc" }, { createdAt: "asc" }],
      take: GROUP_BATCH_SIZE,
      select: { id: true },
    });
    if (rows.length === 0 && mode === "batch") {
      recheck = true;
      rows = await prisma.whatsappGroupMember.findMany({
        where: { ...base, recheck: true },
        orderBy: { createdAt: "asc" },
        take: GROUP_BATCH_SIZE,
        select: { id: true },
      });
    }
    if (rows.length === 0) return 0;

    const ids = rows.map((r) => r.id);
    await prisma.whatsappGroupMember.updateMany({
      where: { id: { in: ids }, status: "PENDIENTE" },
      data: { status: "PROCESANDO", claimedAt: now },
    });
    const claimed = await prisma.whatsappGroupMember.findMany({
      where: { id: { in: ids }, status: "PROCESANDO" },
      orderBy: { createdAt: "asc" },
    });
    if (claimed.length === 0) return 0;

    let results: SmsToolsGroupAddResult[];
    try {
      results = await smsTools.addToGroup(creds, creds.account, group.gid, claimed.map((m) => m.phone), !recheck);
    } catch (err) {
      const status = gatewayStatusOf(err);
      const message = err instanceof Error ? err.message : "Error del proveedor";
      const hard = status !== null && [401, 403, 404, 500].includes(status);
      await prisma.whatsappGroupMember.updateMany({
        where: { id: { in: claimed.map((m) => m.id) } },
        data: { status: "PENDIENTE", ...(hard ? {} : { nextAttemptAt: new Date(Date.now() + TRANSIENT_RETRY_MS) }) },
      });
      if (hard) {
        const reason = pauseReasonFor(status!, message);
        await prisma.whatsappGroup.update({ where: { id: groupId }, data: { pausedReason: reason, pausedAt: new Date() } });
        void notifyOwner(
          group.companyId,
          `⚠️ *Grupo de WhatsApp en pausa*\nNo se pudo agregar clientes al grupo «${group.name}».\n${reason}\nCuando lo corrijas, reanúdalo en Canales → WhatsApp → Grupos.`,
        ).catch(() => undefined);
      } else {
        // Caída o timeout: reintentar es seguro (quien ya entró responde already_in).
        await prisma.whatsappGroup.update({
          where: { id: groupId },
          data: { nextBatchAt: new Date(Date.now() + TRANSIENT_RETRY_MS) },
        });
      }
      console.warn(`[wa-groups] llamada falló (grupo ${groupId}, estado ${status ?? "red"}): ${message}`);
      return 0;
    }

    // El gateway responde un resultado por número EN EL MISMO ORDEN enviado.
    const byPhone = new Map(results.map((r) => [String(r.phone ?? "").replace(/\D/g, ""), r]));
    const resolvedAt = new Date();
    for (let i = 0; i < claimed.length; i += 1) {
      const m = claimed[i];
      const r = results[i] ?? byPhone.get(m.phone) ?? null;
      const raw = r?.status ?? "failed";
      const code = typeof r?.code === "number" ? r.code : null;
      let status = RESULT_STATUS[raw] ?? null;
      const data: Prisma.WhatsappGroupMemberUpdateInput = { lastResult: raw, lastCode: code, recheck: false, immediate: false };
      if (recheck && !status) {
        // Sigue sin entrar: queda como invitado, sin gastar intentos.
        data.status = "INVITADO";
      } else if (status) {
        if (recheck && status === "INVITADO") status = "INVITADO";
        data.status = status;
        data.resolvedAt = resolvedAt;
        data.attempts = m.attempts + 1;
      } else if (m.attempts + 1 < MAX_ATTEMPTS) {
        data.status = "PENDIENTE";
        data.attempts = m.attempts + 1;
        data.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS);
      } else {
        data.status = "FALLIDO";
        data.attempts = m.attempts + 1;
        data.resolvedAt = resolvedAt;
      }
      await prisma.whatsappGroupMember.update({ where: { id: m.id }, data });
      // Nota en el chat solo para contactos sueltos: un lote no debe reordenar cientos de chats.
      if (mode === "immediate" && m.immediate) {
        const text =
          status === "AGREGADO"
            ? `👥 Agregado al grupo «${group.name}».`
            : status === "INVITADO"
              ? `👥 Invitación al grupo «${group.name}» enviada (su privacidad no permite agregarlo directo).`
              : status === "YA_ESTABA"
                ? null
                : status === "EN_ESPERA"
                  ? `👥 No se pudo agregar al grupo «${group.name}»: salió del grupo hace poco.`
                  : `👥 No se pudo agregar al grupo «${group.name}» (${raw}).`;
        if (text) void noteInChat(group.companyId, m.customerId, text);
      }
    }
    if (mode === "batch") {
      await prisma.whatsappGroup.update({
        where: { id: groupId },
        data: { nextBatchAt: new Date(Date.now() + randomGapMs()) },
      });
    }
    return claimed.length;
  } finally {
    processing.delete(groupId);
  }
}

/** Tick del worker: recupera reclamos colgados y despacha un lote por grupo con cola. */
export async function runGroupQueueTick(): Promise<void> {
  const now = new Date();
  await prisma.whatsappGroupMember.updateMany({
    where: { status: "PROCESANDO", claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data: { status: "PENDIENTE" },
  });
  const due = await prisma.whatsappGroupMember.findMany({
    where: { status: "PENDIENTE", nextAttemptAt: { lte: now }, group: { pausedReason: null } },
    select: { groupId: true },
    distinct: ["groupId"],
    take: 200,
  });
  for (const { groupId } of due) {
    try {
      await processGroup(groupId, "batch");
    } catch (err) {
      console.error("[wa-groups] lote falló:", err instanceof Error ? err.message : err);
    }
  }
}
