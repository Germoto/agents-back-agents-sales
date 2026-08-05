/**
 * Motor de ejecución de flujos guiados de chatbot (Company.botMode = "FLOW").
 *
 * Sustituye al agente IA cuando la empresa opera en modo flujos: evalúa los
 * disparadores de los flujos activos, ejecuta cadenas de bloques (texto,
 * multimedia, menús), espera respuestas del cliente, maneja timeouts
 * persistentes (ScheduledMessage FLOW_TIMEOUT) y transferencias entre flujos.
 *
 * Todo el envío pasa por FlowIO (real = deliver vía SMS Tools; simulador =
 * persistencia en canal "sim"), así el mismo motor sirve para producción,
 * timeouts del worker y la página Pruebas.
 */

import { ScheduledMessageType, type ScheduledMessage, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import type { ChatMessage } from "../../lib/openai";
import {
  saveState,
  setBotPaused,
  type ConversationState,
} from "../agent/conversation.service";
import { loadWhatsappSender, sendText, webSender, type WhatsappSender } from "../agent/outbound";
import { deliver, gapMsFor, sleep, OUTBOX_GAP_MS } from "../agent/delivery";
import { cancelPendingReminders, scheduleReminder, minutesFromNow } from "../scheduler/scheduler.service";
import type { OutboxMessage, TurnContext } from "../agent/agent-tools";
import {
  type FlowNode,
  type FlowEdge,
  type FlowTrigger,
  type AnswersData,
  type ListData,
  type SendTextData,
  type SendMediaData,
  type FlowControlData,
  type HandoffData,
  type ReminderData,
  type CrmMoveData,
  type CrmTagsData,
  type ConditionData,
  type WaitData,
  type QuestionData,
  type ValidatePaymentData,
  type BookAppointmentData,
  reminderStepsOf,
  flattenListOptions,
  isSendNode,
} from "./flow-types";
import { applyCrmAndTagActions } from "../crm/crm.service";
import { getEntitlements } from "../billing/entitlements";
import { composePaymentMethodsMessage } from "../agent/payment-methods";
import { schedulePaymentRecheck } from "../scheduler/scheduler.service";
import { getAvailableSlots, isSlotAvailable, formatSlotLabel } from "../bookings/availability.service";
import { createBooking, reasonMessage } from "../bookings/bookings.service";

// ---------------------------------------------------------------------------
// Estado de sesión (namespace `flow` dentro de Conversation.state)
// ---------------------------------------------------------------------------

export interface FlowSessionState {
  sessionFlowId?: string;
  awaitingNodeId?: string;
  awaitingKind?: "reply" | "options" | "question" | "payment" | "booking";
  variables?: Record<string, string>;
  /** flowId -> ISO del último disparo (para reactivationMinutes). */
  lastTriggeredAt?: Record<string, string>;
  /** Estado del bloque «Validar pago» en espera. */
  payment?: { attempts: number };
  /** Estado del bloque «Agendar cita» en espera (slots ofrecidos). */
  booking?: { productId: string; slots: Array<{ startsAt: string; label: string }>; attempts: number };
}

function flowStateOf(state: ConversationState): FlowSessionState {
  if (!state.flow || typeof state.flow !== "object") state.flow = {};
  return state.flow as FlowSessionState;
}

function clearSession(fs: FlowSessionState): void {
  delete fs.sessionFlowId;
  delete fs.awaitingNodeId;
  delete fs.awaitingKind;
  delete fs.payment;
  delete fs.booking;
  // variables y lastTriggeredAt se conservan
}

// ---------------------------------------------------------------------------
// IO del motor
// ---------------------------------------------------------------------------

export interface FlowTraceEntry {
  nodeId: string;
  type: string;
  event: string;
}

export interface FlowIO {
  companyId: string;
  customerId: string;
  conversationId: string;
  customerPhone: string;
  customerName: string | null;
  timezone: string;
  /** Se muta; el caller hace saveState al terminar. */
  state: ConversationState;
  emit(msg: OutboxMessage): Promise<void>;
  notifyOwner(text: string): Promise<void>;
  pauseBot(): Promise<void>;
  scheduleTimeout(flowId: string, nodeId: string, minutes: number): Promise<void>;
  cancelTimeouts(): Promise<void>;
  scheduleReminderMsg(minutes: number, body: string): Promise<void>;
  simulate?: boolean;
  trace?: FlowTraceEntry[];
  /** Pausa (ms) entre bloques encadenados; default OUTBOX_GAP_MS. */
  gapMs?: number;
}

const MAX_CHAIN_PER_TURN = 10;
const MAX_TRANSFERS_PER_TURN = 3;

type LoadedFlow = {
  id: string;
  name: string;
  isActive: boolean;
  trigger: FlowTrigger;
  nodes: FlowNode[];
  edges: FlowEdge[];
  createdAt: Date;
};

function mapFlow(row: {
  id: string;
  name: string;
  isActive: boolean;
  trigger: unknown;
  nodes: unknown;
  edges: unknown;
  createdAt: Date;
}): LoadedFlow {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    trigger: (row.trigger ?? {}) as FlowTrigger,
    nodes: (row.nodes ?? []) as FlowNode[],
    edges: (row.edges ?? []) as FlowEdge[],
    createdAt: row.createdAt,
  };
}

const flowSelect = {
  id: true,
  name: true,
  isActive: true,
  trigger: true,
  nodes: true,
  edges: true,
  createdAt: true,
} as const;

// ---------------------------------------------------------------------------
// Helpers de texto / matching
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function renderTemplate(text: string, io: FlowIO): string {
  const fs = flowStateOf(io.state);
  const vars: Record<string, string> = {
    nombre: io.customerName ?? "",
    telefono: io.customerPhone,
    ...(fs.variables ?? {}),
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key] ?? "");
}

/** Mensajes USER consecutivos del final del historial, unidos (la ráfaga del debounce). */
export function trailingUserText(history: ChatMessage[]): string {
  const parts: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") break;
    if (typeof m.content === "string" && m.content.trim()) parts.unshift(m.content.trim());
  }
  return parts.join("\n");
}

function trailingUserCount(history: ChatMessage[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") break;
    n++;
  }
  return Math.max(1, n);
}

/** Medianoche de HOY en la zona horaria del negocio. */
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

function renderListMenu(data: ListData, io: FlowIO): string {
  const lines: string[] = [];
  if (data.title?.trim()) lines.push(`*${renderTemplate(data.title.trim(), io)}*`);
  if (data.body?.trim()) lines.push(renderTemplate(data.body.trim(), io));
  const sections = data.sections ?? [];
  let n = 0;
  for (const section of sections) {
    const opts = section.options ?? [];
    if (!opts.length) continue;
    if (section.title?.trim() && sections.length > 1) {
      lines.push("");
      lines.push(`*${renderTemplate(section.title.trim(), io)}*`);
    } else {
      lines.push("");
    }
    for (const opt of opts) {
      n += 1;
      const desc = opt.description?.trim() ? ` — ${renderTemplate(opt.description.trim(), io)}` : "";
      lines.push(`${n}. ${renderTemplate(opt.label, io)}${desc}`);
    }
  }
  lines.push("");
  lines.push(data.footer?.trim() ? renderTemplate(data.footer.trim(), io) : "Responde con el número de tu opción 👆");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Candidatos de matching: el texto completo y cada línea por separado. El
 * debounce junta la ráfaga del cliente con "\n" (p.ej. "2\npor qué no
 * respondes"), así que la opción puede venir en cualquier línea.
 */
function candidateInputs(inbound: string): string[] {
  const whole = normalize(inbound);
  const lines = inbound
    .split(/\n+/)
    .map((l) => normalize(l))
    .filter(Boolean);
  return [...new Set([whole, ...lines])].filter(Boolean);
}

function matchAnswersOption(data: AnswersData, inbound: string): string | null {
  const candidates = candidateInputs(inbound);
  if (!candidates.length) return null;
  for (const opt of data.options ?? []) {
    const target = normalize(opt.detectText ?? "");
    if (!target) continue;
    const mode = opt.detectMode ?? "contains";
    for (const input of candidates) {
      const ok =
        mode === "equals"
          ? input === target
          : mode === "starts_with"
            ? input.startsWith(target)
            : mode === "ends_with"
              ? input.endsWith(target)
              : input.includes(target);
      if (ok) return opt.id;
    }
  }
  return null;
}

function matchListOption(data: ListData, inbound: string): string | null {
  const candidates = candidateInputs(inbound);
  if (!candidates.length) return null;
  const flat = flattenListOptions(data);
  // 1) por número global ("2", "2.", "opción 2", "2 por favor")
  for (const input of candidates) {
    const numMatch = input.match(/^(?:opcion\s*)?(\d{1,2})\.?(?:\s|$)/);
    if (!numMatch) continue;
    const n = Number(numMatch[1]);
    const byNumber = flat.find((o) => o.number === n);
    if (byNumber) return byNumber.id;
  }
  // 2) por texto del label (igual, o contenido si el label es significativo)
  for (const opt of flat) {
    const label = normalize(opt.label ?? "");
    if (!label) continue;
    for (const input of candidates) {
      if (input === label) return opt.id;
      if (label.length >= 3 && input.includes(label)) return opt.id;
    }
  }
  return null;
}

function edgeFrom(flow: LoadedFlow, nodeId: string, handle: string): FlowEdge | undefined {
  return flow.edges.find((e) => e.source === nodeId && (e.sourceHandle ?? "next") === handle);
}

function nodeById(flow: LoadedFlow, id: string | undefined | null): FlowNode | undefined {
  if (!id) return undefined;
  return flow.nodes.find((n) => n.id === id);
}

function startTargetOf(flow: LoadedFlow): string | null {
  const start = flow.nodes.find((n) => n.type === "start");
  if (!start) return null;
  const edge = flow.edges.find((e) => e.source === start.id);
  return edge?.target ?? null;
}

function pushTrace(io: FlowIO, node: FlowNode | { id: string; type: string }, event: string): void {
  io.trace?.push({ nodeId: node.id, type: node.type, event });
}

// ---------------------------------------------------------------------------
// Núcleo
// ---------------------------------------------------------------------------

export async function runFlowTurn(io: FlowIO, inboundText: string, history?: ChatMessage[]): Promise<void> {
  const fs = flowStateOf(io.state);

  // Nombre del cliente (para {{nombre}}) si el caller no lo resolvió
  if (io.customerName === null) {
    const c = await prisma.customer.findUnique({ where: { id: io.customerId }, select: { name: true } });
    io.customerName = c?.name ?? "";
  }

  // (a) RESUME: hay una sesión esperando respuesta del cliente
  if (fs.awaitingNodeId && fs.sessionFlowId) {
    const row = await prisma.chatFlow.findFirst({
      where: { id: fs.sessionFlowId, companyId: io.companyId },
      select: flowSelect,
    });
    const flow = row ? mapFlow(row) : null;
    const node = flow ? nodeById(flow, fs.awaitingNodeId) : undefined;

    if (flow && node) {
      await io.cancelTimeouts();

      // Bloque «Validar pago» esperando el pago del cliente
      if (fs.awaitingKind === "payment" && node.type === "validate-payment") {
        await resumePaymentAwaiting(flow, node, io, inboundText);
        return;
      }

      // Bloque «Agendar cita» esperando la elección del horario
      if (fs.awaitingKind === "booking" && node.type === "book-appointment") {
        await resumeBookingAwaiting(flow, node, io, inboundText);
        return;
      }

      // Pregunta validada: validar/normalizar según el tipo de dato
      if (node.type === "question") {
        const qdata = node.data as QuestionData;
        const value = validateQuestionAnswer(qdata, inboundText);
        if (value === null) {
          pushTrace(io, node, "invalid-answer");
          const msg =
            qdata.invalidMessage?.trim() || "Mmm, ese dato no parece válido. Inténtalo de nuevo 🙏";
          await io.emit({ kind: "text", text: renderTemplate(msg, io) });
          await armTimeout(flow, node, io);
          return; // sigue esperando en el mismo nodo
        }
        if (qdata.saveVariable?.trim()) {
          fs.variables = { ...(fs.variables ?? {}), [qdata.saveVariable.trim()]: value };
        }
        fs.awaitingNodeId = undefined;
        fs.awaitingKind = undefined;
        pushTrace(io, node, "resolved:next");
        const edge = edgeFrom(flow, node.id, "next");
        if (!edge) {
          clearSession(fs);
          return;
        }
        await runChain(flow, edge.target, io);
        return;
      }

      const resolved = resolveAwaiting(node, inboundText);

      if (resolved.kind === "no-match") {
        pushTrace(io, node, "no-match");
        const data = node.data as AnswersData | ListData;
        if (data.repeatOnNoMatch) {
          if (data.noMatchMessage?.trim()) {
            await io.emit({ kind: "text", text: renderTemplate(data.noMatchMessage.trim(), io) });
            await pause(io);
          }
          await emitQuestion(node, io);
          await armTimeout(flow, node, io);
          pushTrace(io, node, "repeated");
          return; // sigue esperando en el mismo nodo
        }
        clearSession(fs);
        return; // silencio; el próximo mensaje re-evalúa disparadores
      }

      // Guardar variable con la respuesta cruda
      const saveVariable = (node.data as { saveVariable?: string }).saveVariable;
      if (saveVariable?.trim() && inboundText.trim()) {
        fs.variables = { ...(fs.variables ?? {}), [saveVariable.trim()]: inboundText.trim() };
      }

      fs.awaitingNodeId = undefined;
      fs.awaitingKind = undefined;
      pushTrace(io, node, `resolved:${resolved.handle}`);

      const edge = edgeFrom(flow, node.id, resolved.handle);
      if (!edge) {
        clearSession(fs);
        return;
      }
      await runChain(flow, edge.target, io);
      return;
    }

    // Flujo/nodo desaparecido (editado/borrado): degradar limpio y re-evaluar triggers
    clearSession(fs);
  }

  // (b) TRIGGER: evaluar flujos activos
  const rows = await prisma.chatFlow.findMany({
    where: { companyId: io.companyId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: flowSelect,
  });
  if (!rows.length) return;
  const flows = rows.map(mapFlow);

  const winner = await pickTriggeredFlow(flows, inboundText, io, history);
  if (!winner) return; // sin match → silencio

  fs.lastTriggeredAt = { ...(fs.lastTriggeredAt ?? {}), [winner.id]: new Date().toISOString() };
  fs.sessionFlowId = winner.id;
  pushTrace(io, { id: "start", type: "start" }, `triggered:${winner.name}`);

  const entry = startTargetOf(winner);
  if (!entry) {
    clearSession(fs);
    return;
  }
  await runChain(winner, entry, io);
}

type Resolved = { kind: "handle"; handle: string } | { kind: "no-match" };

function resolveAwaiting(node: FlowNode, inboundText: string): Resolved {
  if (isSendNode(node.type)) {
    return { kind: "handle", handle: "reply" };
  }
  if (node.type === "answers") {
    const optId = matchAnswersOption(node.data as AnswersData, inboundText);
    return optId ? { kind: "handle", handle: `opt:${optId}` } : { kind: "no-match" };
  }
  if (node.type === "list") {
    const optId = matchListOption(node.data as ListData, inboundText);
    return optId ? { kind: "handle", handle: `opt:${optId}` } : { kind: "no-match" };
  }
  return { kind: "no-match" };
}

async function pickTriggeredFlow(
  flows: LoadedFlow[],
  inboundText: string,
  io: FlowIO,
  history?: ChatMessage[],
): Promise<LoadedFlow | null> {
  const fs = flowStateOf(io.state);
  const input = normalize(inboundText);
  const now = Date.now();

  // ¿Algún flujo necesita "primer mensaje"? Calcular solo si hace falta.
  const needsFirst = flows.some(
    (f) => (f.trigger.onFirstMessageEver || f.trigger.onFirstMessageOfDay) && f.trigger,
  );
  let firstEver = false;
  let firstOfDay = false;
  if (needsFirst) {
    const burst = history ? trailingUserCount(history) : 1;
    const [totalUser, userToday] = await Promise.all([
      prisma.conversationMessage.count({
        where: { conversationId: io.conversationId, role: "USER" },
      }),
      prisma.conversationMessage.count({
        where: {
          conversationId: io.conversationId,
          role: "USER",
          createdAt: { gte: startOfTodayInTz(io.timezone) },
        },
      }),
    ]);
    firstEver = totalUser <= burst;
    firstOfDay = userToday <= burst;
  }

  let winner: { flow: LoadedFlow; bucket: number } | null = null;
  for (const flow of flows) {
    const t = flow.trigger ?? ({} as FlowTrigger);

    // Intervalo de reactivación
    const reactivation = Number(t.reactivationMinutes ?? 0);
    if (reactivation > 0) {
      const last = fs.lastTriggeredAt?.[flow.id];
      if (last && now - new Date(last).getTime() < reactivation * 60_000) continue;
    }

    let bucket: number | null = null;
    const keywords = (t.keywords ?? []).map(normalize).filter(Boolean);
    if (keywords.length && input && keywords.some((k) => input.includes(k))) bucket = 0;
    else if (t.onFirstMessageEver && firstEver) bucket = 1;
    else if (t.onFirstMessageOfDay && firstOfDay) bucket = 2;
    else if (t.onAnyMessage) bucket = 3;

    if (bucket === null) continue;
    if (!winner || bucket < winner.bucket) winner = { flow, bucket };
  }
  return winner?.flow ?? null;
}

async function emitQuestion(node: FlowNode, io: FlowIO): Promise<void> {
  if (node.type === "answers") {
    const data = node.data as AnswersData;
    if (data.message?.trim()) {
      await io.emit({ kind: "text", text: renderTemplate(data.message.trim(), io) });
    }
    return;
  }
  if (node.type === "list") {
    await io.emit({ kind: "text", text: renderListMenu(node.data as ListData, io) });
  }
}

async function armTimeout(flow: LoadedFlow, node: FlowNode, io: FlowIO): Promise<void> {
  const data = node.data as AnswersData | ListData | QuestionData;
  const minutes = Number(data.timeoutMinutes ?? 0);
  if (minutes > 0 && edgeFrom(flow, node.id, "timeout")) {
    await io.scheduleTimeout(flow.id, node.id, minutes);
    pushTrace(io, node, `timeout-armed:${minutes}m`);
  }
}

async function pause(io: FlowIO): Promise<void> {
  if (!io.simulate) await sleep(io.gapMs ?? OUTBOX_GAP_MS);
}

/**
 * Valida la respuesta a una «Pregunta» según el tipo de dato. Devuelve el
 * valor normalizado (phone: solo dígitos; email: minúsculas) o null si no
 * cumple el formato.
 */
function validateQuestionAnswer(data: QuestionData, inbound: string): string | null {
  const text = inbound.trim();
  if (!text) return null;
  switch (data.varType) {
    case "number": {
      const cleaned = text.replace(/\s/g, "").replace(",", ".");
      return /^-?\d+(\.\d+)?$/.test(cleaned) ? cleaned : null;
    }
    case "email": {
      const candidate = text.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(candidate) ? candidate : null;
    }
    case "phone": {
      const digits = text.replace(/\D/g, "");
      return digits.length >= 6 && digits.length <= 15 ? digits : null;
    }
    case "text":
    default:
      return text;
  }
}

/** Evalúa una «Condición»: variable guardada, etiqueta del cliente o compra previa. */
async function evalCondition(node: FlowNode, io: FlowIO): Promise<boolean> {
  const data = node.data as ConditionData;

  if (data.source === "purchased") {
    const purchased = io.state.purchasedProductIds;
    return Array.isArray(purchased) && purchased.length > 0;
  }

  if (data.source === "tag") {
    if (!data.tagId) return false;
    // En simulación sí consultamos (solo lectura, sin side-effects)
    const link = await prisma.customerTagLink.findFirst({
      where: { customerId: io.customerId, tagId: data.tagId },
      select: { customerId: true },
    });
    return Boolean(link);
  }

  // source === "variable"
  const fs = flowStateOf(io.state);
  const name = (data.variable ?? "").trim();
  const raw =
    name === "nombre"
      ? (io.customerName ?? "")
      : name === "telefono"
        ? io.customerPhone
        : (fs.variables?.[name] ?? "");
  const val = normalize(String(raw));
  const cmp = normalize(String(data.value ?? ""));
  switch (data.operator) {
    case "equals":
      return val === cmp;
    case "contains":
      return cmp.length > 0 && val.includes(cmp);
    case "empty":
      return val.length === 0;
    case "not_empty":
    default:
      return val.length > 0;
  }
}

/**
 * Bloques CRM (crm-move / crm-add-tags / crm-remove-tags): side-effect
 * best-effort sobre el cliente. En simulación no toca datos reales; si el plan
 * del tenant no incluye el módulo CRM, se omite y el flujo continúa por "next".
 */
async function runCrmNode(node: FlowNode, io: FlowIO): Promise<void> {
  if (io.simulate) {
    pushTrace(io, node, "crm:simulado (no se aplican cambios reales)");
    return;
  }
  const ent = await getEntitlements(io.companyId); // caché 60s; LEGACY incluye CRM
  if (!ent.modules.includes("CRM")) {
    pushTrace(io, node, "crm:omitido (plan sin módulo CRM)");
    return;
  }
  if (node.type === "crm-move") {
    const data = node.data as CrmMoveData;
    if (!data.crmId || !data.crmColumnId) return;
    await applyCrmAndTagActions(io.companyId, io.customerId, {
      crmId: data.crmId,
      crmColumnId: data.crmColumnId,
    });
  } else {
    const data = node.data as CrmTagsData;
    if (!data.tagIds?.length) return;
    await applyCrmAndTagActions(
      io.companyId,
      io.customerId,
      node.type === "crm-add-tags" ? { tagIds: data.tagIds } : { removeTagIds: data.tagIds },
    );
  }
  pushTrace(io, node, `${node.type}:aplicado`);
}

const MEDIA_KIND_BY_NODE: Record<string, "image" | "video" | "audio" | "document"> = {
  "send-image": "image",
  "send-video": "video",
  "send-audio": "audio",
  "send-document": "document",
};

async function runChain(flow: LoadedFlow, entryNodeId: string, io: FlowIO): Promise<void> {
  const fs = flowStateOf(io.state);
  let current: string | null = entryNodeId;
  let activeFlow = flow;
  let chained = 0;
  let transfers = 0;
  let emitted = 0;

  while (current) {
    const node = nodeById(activeFlow, current);
    if (!node) {
      clearSession(fs);
      return;
    }

    // Handle de continuación; los bloques con ramas (condition) lo sobreescriben.
    let nextHandle = "next";

    switch (node.type) {
      case "start": {
        current = startTargetOf(activeFlow);
        continue;
      }

      case "send-text": {
        const data = node.data as SendTextData;
        if (emitted > 0) await pause(io);
        await io.emit({ kind: "text", text: renderTemplate(data.text ?? "", io) });
        emitted++;
        pushTrace(io, node, "emitted");
        break;
      }

      case "send-image":
      case "send-video":
      case "send-audio":
      case "send-document": {
        const data = node.data as SendMediaData;
        if (emitted > 0) await pause(io);
        await io.emit({
          kind: "media",
          mediaUrl: data.mediaUrl,
          mediaKind: MEDIA_KIND_BY_NODE[node.type],
          caption: data.caption?.trim() ? renderTemplate(data.caption.trim(), io) : undefined,
          fileName: data.fileName,
        });
        emitted++;
        pushTrace(io, node, "emitted");
        break;
      }

      case "answers":
      case "list": {
        if (emitted > 0) await pause(io);
        await emitQuestion(node, io);
        emitted++;
        fs.awaitingNodeId = node.id;
        fs.awaitingKind = "options";
        fs.sessionFlowId = activeFlow.id;
        await armTimeout(activeFlow, node, io);
        pushTrace(io, node, "awaiting-options");
        return;
      }

      case "flow-control": {
        const data = node.data as FlowControlData;
        if (++transfers > MAX_TRANSFERS_PER_TURN) {
          console.warn(`[flows] límite de transferencias alcanzado (flow=${activeFlow.id})`);
          clearSession(fs);
          return;
        }
        if (data.action === "restart") {
          pushTrace(io, node, "restart");
          current = startTargetOf(activeFlow);
          continue;
        }
        if (data.action === "transfer" && data.targetFlowId) {
          const row = await prisma.chatFlow.findFirst({
            where: { id: data.targetFlowId, companyId: io.companyId },
            select: flowSelect,
          });
          if (!row) {
            clearSession(fs);
            return;
          }
          activeFlow = mapFlow(row); // puede estar inactivo (sub-flujo)
          fs.sessionFlowId = activeFlow.id;
          pushTrace(io, node, `transfer:${activeFlow.name}`);
          current = startTargetOf(activeFlow);
          continue;
        }
        clearSession(fs);
        return;
      }

      case "handoff": {
        const data = node.data as HandoffData;
        // Mensaje al cliente antes de pausar (ej. "en un momento te atiende un asesor")
        if (data.clientText?.trim()) {
          if (emitted > 0) await pause(io);
          await io.emit({ kind: "text", text: renderTemplate(data.clientText.trim(), io) });
          emitted++;
        }
        const num = io.customerPhone.replace(/\D/g, "");
        const text =
          data.notifyText?.trim()
            ? renderTemplate(data.notifyText.trim(), io)
            : `🔔 Un cliente (${io.customerPhone}) pidió hablar con un asesor (flujo de chatbot).\n` +
              `El bot quedó pausado para este cliente.\n` +
              `• Responder: *${num} tu mensaje*\n` +
              `• Reactivar el bot: *BOT ${num}*`;
        await io.notifyOwner(text);
        await io.pauseBot();
        clearSession(fs);
        pushTrace(io, node, "handoff");
        return;
      }

      case "reminder": {
        const data = node.data as ReminderData;
        // Secuencia de hasta 5 envíos con delays ACUMULATIVOS; si el cliente
        // escribe antes, los CUSTOM pendientes se cancelan (comportamiento ya
        // existente del pipeline de inbound).
        const steps = reminderStepsOf(data).slice(0, 5);
        let acc = 0;
        for (const st of steps) {
          if (!(st.minutes > 0) || !st.message?.trim()) continue;
          acc += st.minutes;
          await io.scheduleReminderMsg(acc, renderTemplate(st.message.trim(), io));
        }
        if (steps.length) pushTrace(io, node, `reminder:${steps.length} envío(s)`);
        break;
      }
      case "crm-move":
      case "crm-add-tags":
      case "crm-remove-tags": {
        await runCrmNode(node, io);
        break;
      }

      case "condition": {
        const result = await evalCondition(node, io);
        nextHandle = result ? "yes" : "no";
        pushTrace(io, node, `condition:${nextHandle}`);
        break;
      }

      case "wait": {
        const data = node.data as WaitData;
        const secs = Math.min(Math.max(Number(data.seconds) || 0, 0), 120);
        if (secs > 0 && !io.simulate) await sleep(secs * 1000);
        pushTrace(io, node, `wait:${secs}s`);
        break;
      }

      case "question": {
        const data = node.data as QuestionData;
        if (emitted > 0) await pause(io);
        if (data.message?.trim()) {
          await io.emit({ kind: "text", text: renderTemplate(data.message.trim(), io) });
        }
        emitted++;
        fs.awaitingNodeId = node.id;
        fs.awaitingKind = "question";
        fs.sessionFlowId = activeFlow.id;
        await armTimeout(activeFlow, node, io);
        pushTrace(io, node, "awaiting-question");
        return;
      }

      case "validate-payment": {
        const data = node.data as ValidatePaymentData;
        const setup = await preparePaymentCharge(io, data);
        if (!setup) {
          // Sin métodos configurados: red de seguridad (la paleta ya lo gatea).
          pushTrace(io, node, "payment:sin-metodos");
          const reviewEdge = edgeFrom(activeFlow, node.id, "review");
          if (reviewEdge) {
            nextHandle = "review";
            break;
          }
          clearSession(fs);
          return;
        }
        if (emitted > 0) await pause(io);
        if (data.instructions?.trim()) {
          await io.emit({ kind: "text", text: renderTemplate(data.instructions.trim(), io) });
          await pause(io);
        }
        await io.emit({ kind: "text", text: setup.text });
        if (io.simulate) {
          await io.emit({
            kind: "text",
            text: "(simulación) Escribe *aprobar*, *rechazar* o *revision* para probar cada rama del bloque.",
          });
        }
        emitted++;
        // Habilita el contexto de pago (la visión del voucher lo usa).
        io.state.status = "ESPERANDO_PAGO";
        io.state.lastPaymentPromptAt = new Date().toISOString();
        fs.awaitingNodeId = node.id;
        fs.awaitingKind = "payment";
        fs.sessionFlowId = activeFlow.id;
        fs.payment = { attempts: 0 };
        await armPaymentTimeout(activeFlow, node, io);
        pushTrace(io, node, "awaiting-payment");
        return;
      }

      case "book-appointment": {
        const data = node.data as BookAppointmentData;
        const productId = data.productId ?? "";
        let slots: Array<{ startsAt: string; label: string }> = [];
        let ok = false;
        if (productId) {
          try {
            const res = await getAvailableSlots(io.companyId, productId, { limit: 6 });
            ok = res.configured;
            slots = res.slots.map((sl) => ({ startsAt: sl.startsAt, label: sl.label }));
          } catch {
            ok = false;
          }
        }
        if (!ok || !slots.length) {
          if (data.noSlotsMessage?.trim()) {
            if (emitted > 0) await pause(io);
            await io.emit({ kind: "text", text: renderTemplate(data.noSlotsMessage.trim(), io) });
            emitted++;
          }
          pushTrace(io, node, "booking:no-slots");
          nextHandle = "no-slots";
          break;
        }
        if (emitted > 0) await pause(io);
        const intro = data.introMessage?.trim() || "Estos son los horarios disponibles 📅 Elige el que prefieras:";
        await io.emit({ kind: "text", text: renderBookingMenu(renderTemplate(intro, io), slots) });
        emitted++;
        fs.awaitingNodeId = node.id;
        fs.awaitingKind = "booking";
        fs.sessionFlowId = activeFlow.id;
        fs.booking = { productId, slots, attempts: 0 };
        await armBookingTimeout(activeFlow, node, io);
        pushTrace(io, node, "awaiting-booking");
        return;
      }
    }

    // Encadenar por "next" (send-*, reminder) o la rama elegida (condition)
    const replyEdge = isSendNode(node.type) ? edgeFrom(activeFlow, node.id, "reply") : undefined;
    if (replyEdge) {
      fs.awaitingNodeId = node.id;
      fs.awaitingKind = "reply";
      fs.sessionFlowId = activeFlow.id;
      pushTrace(io, node, "awaiting-reply");
      return;
    }
    const nextEdge = edgeFrom(activeFlow, node.id, nextHandle);
    if (!nextEdge) {
      clearSession(fs);
      return;
    }
    if (++chained > MAX_CHAIN_PER_TURN) {
      console.warn(`[flows] límite de bloques encadenados alcanzado (flow=${activeFlow.id})`);
      clearSession(fs);
      return;
    }
    current = nextEdge.target;
  }
}

// ---------------------------------------------------------------------------
// Timeout: lo invoca el scheduler worker cuando vence un FLOW_TIMEOUT
// ---------------------------------------------------------------------------

interface FlowTimeoutMetadata {
  kind?: string;
  conversationId?: string;
  flowId?: string;
  nodeId?: string;
}

export async function resumeFlowOnTimeout(msg: ScheduledMessage): Promise<void> {
  const meta = (msg.metadata ?? {}) as FlowTimeoutMetadata;
  if (!meta.conversationId || !meta.flowId || !meta.nodeId) return;

  const convo = await prisma.conversation.findUnique({
    where: { id: meta.conversationId },
    select: {
      id: true,
      companyId: true,
      customerId: true,
      botPaused: true,
      state: true,
      channel: true,
      customer: { select: { name: true, phone: true } },
    },
  });
  if (!convo || convo.botPaused || (convo.channel !== "whatsapp" && convo.channel !== "web")) return;

  const state = (convo.state as ConversationState) ?? {};
  const fs = flowStateOf(state);
  // Timeout obsoleto: el cliente ya respondió o la sesión cambió
  if (fs.awaitingNodeId !== meta.nodeId || fs.sessionFlowId !== meta.flowId) return;

  const row = await prisma.chatFlow.findFirst({
    where: { id: meta.flowId, companyId: convo.companyId },
    select: flowSelect,
  });
  if (!row) return;
  const flow = mapFlow(row);
  const node = nodeById(flow, meta.nodeId);
  const edge = node ? edgeFrom(flow, node.id, "timeout") : undefined;
  if (!node || !edge) return;

  const sender = convo.channel === "web" ? webSender(convo.id) : await loadWhatsappSender(convo.companyId);
  if (!sender) return;

  const company = await prisma.company.findUnique({
    where: { id: convo.companyId },
    select: { timezone: true, messageGapEnabled: true, messageGapSeconds: true },
  });

  fs.awaitingNodeId = undefined;
  fs.awaitingKind = undefined;

  const io = buildWhatsappFlowIO({
    companyId: convo.companyId,
    customerId: convo.customerId,
    conversationId: convo.id,
    customerPhone: convo.customer.phone,
    customerName: convo.customer.name,
    timezone: company?.timezone ?? "America/Lima",
    gapMs: gapMsFor(company),
    state,
    sender,
    ownerPhone: null, // se resuelve adentro si hace falta (handoff tras timeout)
  });

  try {
    await runChain(flow, edge.target, io);
  } finally {
    await saveState(convo.id, state);
  }
}

// ---------------------------------------------------------------------------
// Bloque «Validar pago»
// ---------------------------------------------------------------------------

const PAYMENT_RETRY_DEFAULT =
  "Aún no encuentro tu pago 🙏 Cuando pagues, envíame la *captura del comprobante* (Yape/Plin) o avísame si pagaste por el link 💳";
const PAYMENT_REVIEW_DEFAULT =
  "Recibí tu comprobante 🧾 Lo estamos verificando; en unos minutos te confirmo por aquí 🙌";

/** Arma el mensaje de cobro del bloque; null = pagos sin configurar. */
async function preparePaymentCharge(
  io: FlowIO,
  data: ValidatePaymentData,
): Promise<{ text: string; productIds: string[] } | null> {
  const { buildBotConfig } = await import("../bot/bot.service");
  const config = await buildBotConfig(io.companyId);
  const payment = config.payment as {
    enabled?: boolean;
    methods: Array<{ method: string; number: string; holder: string }>;
    mp?: { enabled?: boolean; accessTokenEnc?: string | null } | null;
  };
  if (!payment?.enabled || (!payment.methods.length && !payment.mp?.enabled)) return null;

  let amountNum = 0;
  let amountText = "";
  let title = "Pago";
  let productIds: string[] = [];
  if (data.amountMode === "product" && data.productId) {
    const products = (config as { products?: Array<{ id: string; name?: string; priceText?: string; price?: string }> }).products ?? [];
    const p = products.find((x) => x.id === data.productId);
    const raw = p?.priceText ?? p?.price ?? "";
    amountNum = Number(String(raw).replace(/[^\d.]/g, "")) || 0;
    amountText = raw || `S/ ${amountNum.toFixed(2)}`;
    title = p?.name ?? title;
    productIds = [data.productId];
    // Para que el matching/entrega resuelvan el producto igual que el agente.
    io.state.selectedProductId = data.productId;
  } else {
    amountNum = Number(data.amount) || 0;
    amountText = `S/ ${amountNum.toFixed(2)}`;
  }
  if (!(amountNum > 0)) return null;

  const { text } = await composePaymentMethodsMessage({
    companyId: io.companyId,
    conversationId: io.conversationId,
    payment,
    state: io.state,
    amountNum,
    amountText,
    title,
    productIds,
    simulate: io.simulate,
  });
  return { text, productIds };
}

async function armPaymentTimeout(flow: LoadedFlow, node: FlowNode, io: FlowIO): Promise<void> {
  const data = node.data as ValidatePaymentData;
  const minutes = Number(data.timeoutMinutes ?? 60);
  if (minutes > 0 && edgeFrom(flow, node.id, "timeout")) {
    await io.scheduleTimeout(flow.id, node.id, minutes);
    pushTrace(io, node, `timeout-armed:${minutes}m`);
  }
}

async function armBookingTimeout(flow: LoadedFlow, node: FlowNode, io: FlowIO): Promise<void> {
  const data = node.data as BookAppointmentData;
  const minutes = Number(data.timeoutMinutes ?? 30);
  if (minutes > 0 && edgeFrom(flow, node.id, "timeout")) {
    await io.scheduleTimeout(flow.id, node.id, minutes);
    pushTrace(io, node, `timeout-armed:${minutes}m`);
  }
}

/** Continúa el flujo por una rama del nodo (limpia el awaiting antes). */
async function continueByHandle(flow: LoadedFlow, node: FlowNode, io: FlowIO, handle: string): Promise<void> {
  const fs = flowStateOf(io.state);
  fs.awaitingNodeId = undefined;
  fs.awaitingKind = undefined;
  delete fs.payment;
  delete fs.booking;
  pushTrace(io, node, `resolved:${handle}`);
  const edge = edgeFrom(flow, node.id, handle);
  if (!edge) {
    clearSession(fs);
    return;
  }
  await runChain(flow, edge.target, io);
}

/** Resuelve el mensaje del cliente mientras el bloque «Validar pago» espera. */
async function resumePaymentAwaiting(flow: LoadedFlow, node: FlowNode, io: FlowIO, inboundText: string): Promise<void> {
  const fs = flowStateOf(io.state);
  const data = node.data as ValidatePaymentData;
  const text = (inboundText ?? "").trim();

  // Simulación: probar ramas escribiendo la palabra clave.
  if (io.simulate) {
    const lower = text.toLowerCase();
    if (lower.startsWith("aprobar")) return continueByHandle(flow, node, io, "approved");
    if (lower.startsWith("rechazar")) return continueByHandle(flow, node, io, "rejected");
    if (lower.startsWith("revision") || lower.startsWith("revisión")) return continueByHandle(flow, node, io, "review");
    await io.emit({
      kind: "text",
      text: "(simulación) Escribe *aprobar*, *rechazar* o *revision* para avanzar por esa rama.",
    });
    await armPaymentTimeout(flow, node, io);
    return;
  }

  // Señales de pago: código leído por visión del voucher + dígitos del texto + posible titular.
  const lastReceipt = io.state.lastReceipt as
    | { securityCode?: string | null; operationNumber?: string | null; at?: string | null; mediaUrl?: string | null }
    | undefined;
  const codes = [lastReceipt?.securityCode, lastReceipt?.operationNumber, ...(text.match(/\d{3,}/g) ?? [])]
    .map((c) => String(c ?? "").replace(/\D/g, ""))
    .filter((c) => c.length >= 3);
  const looksLikeName = /^[\p{L}\s.'-]{2,60}$/u.test(text) && /\p{L}{2,}/u.test(text);
  const payerName = looksLikeName ? text : undefined;
  const receiptFresh = Boolean(
    lastReceipt?.at && Date.now() - new Date(lastReceipt.at).getTime() < 15 * 60_000,
  );

  if (!codes.length && !payerName && !receiptFresh) {
    // Texto sin evidencia de pago: recordarle cómo pagar sin consumir salida.
    const retry = data.retryMessage?.trim() || PAYMENT_RETRY_DEFAULT;
    await io.emit({ kind: "text", text: renderTemplate(retry, io) });
    await armPaymentTimeout(flow, node, io);
    pushTrace(io, node, "payment:retry");
    return;
  }

  const { tryApprovePayment } = await import("../agent/agent-tools");
  const { buildBotConfig } = await import("../bot/bot.service");
  const config = await buildBotConfig(io.companyId);
  const expected =
    data.amountMode === "fixed" && Number(data.amount) > 0 ? Number(data.amount) : undefined;
  const result = await tryApprovePayment({
    companyId: io.companyId,
    customerId: io.customerId,
    conversationId: io.conversationId,
    customerPhone: io.customerPhone,
    config: config as Parameters<typeof tryApprovePayment>[0]["config"],
    state: io.state,
    payerName,
    codes,
    expected,
    deliver: true,
  });

  if (result.approved) {
    if (result.customerMessage) await io.emit({ kind: "text", text: result.customerMessage });
    for (const msg of result.deliveryOutbox ?? []) {
      await pause(io);
      await io.emit(msg);
    }
    if (result.manualNeeded?.length) {
      await io.notifyOwner(
        `📦 Pago aprobado de ${io.customerPhone}: hay productos con entrega MANUAL pendiente. Revisa Comprobantes.`,
      );
    }
    pushTrace(io, node, "payment:approved");
    return continueByHandle(flow, node, io, "approved");
  }

  const attempts = fs.payment?.attempts ?? 0;
  if (receiptFresh && attempts === 0) {
    // Voucher recién enviado y sin match todavía: puede ser timing de ValidPay.
    fs.payment = { attempts: 1 };
    if (result.customerMessage) await io.emit({ kind: "text", text: result.customerMessage });
    else await io.emit({ kind: "text", text: "Estoy validando tu pago automáticamente 🙏 dame un momentito y te confirmo." });
    try {
      await schedulePaymentRecheck({
        companyId: io.companyId,
        customerId: io.customerId,
        conversationId: io.conversationId,
        sendAt: new Date(Date.now() + 75_000),
        operationCode: codes[0] ?? null,
        expectedAmount: expected ?? null,
        payerName: payerName ?? null,
        customerPhone: io.customerPhone,
        receiptMediaUrl: lastReceipt?.mediaUrl ?? null,
      });
    } catch {
      /* best-effort */
    }
    await armPaymentTimeout(flow, node, io);
    pushTrace(io, node, "payment:recheck-armed");
    return;
  }

  // Sin match tras el recheck (o señal débil repetida): pasa a revisión manual.
  await goPaymentReview(flow, node, io);
}

/**
 * Pasa el pago a revisión manual: avisa al cliente y al dueño, corre la rama
 * `review` del flujo y DEJA el nodo esperando para que la aprobación/rechazo
 * desde el panel continúe por `approved`/`rejected` (hook resumeFlowOnPaymentOutcome).
 */
async function goPaymentReview(flow: LoadedFlow, node: FlowNode, io: FlowIO): Promise<void> {
  const fs = flowStateOf(io.state);
  const data = node.data as ValidatePaymentData;
  const review = data.reviewMessage?.trim() || PAYMENT_REVIEW_DEFAULT;
  await io.emit({ kind: "text", text: renderTemplate(review, io) });
  await io.notifyOwner(
    `🧾 Pago por revisar de ${io.customerPhone}: no pude validarlo automáticamente. ` +
      `Apruébalo o recházalo desde Comprobantes; el flujo continuará solo.`,
  );
  io.state.status = "ESPERANDO_VALIDACION";
  pushTrace(io, node, "payment:review");

  // Correr la rama review conservando la espera del nodo: snapshot + restore.
  const snapshot = {
    sessionFlowId: fs.sessionFlowId,
    awaitingNodeId: fs.awaitingNodeId,
    awaitingKind: fs.awaitingKind,
    payment: fs.payment,
  };
  const edge = edgeFrom(flow, node.id, "review");
  if (edge) {
    fs.awaitingNodeId = undefined;
    fs.awaitingKind = undefined;
    await runChain(flow, edge.target, io);
  }
  // Si la rama review terminó (o no existe), el nodo vuelve a esperar el veredicto del panel.
  if (!fs.awaitingNodeId) {
    fs.sessionFlowId = snapshot.sessionFlowId;
    fs.awaitingNodeId = snapshot.awaitingNodeId;
    fs.awaitingKind = snapshot.awaitingKind;
    fs.payment = snapshot.payment;
    await armPaymentTimeout(flow, node, io);
  }
}

/**
 * Hook: un evento de pago (webhook MP, recheck, panel) resuelve el bloque
 * «Validar pago» de un flujo en espera. No-op absoluto si no hay flujo esperando
 * (modo AI, sesión cerrada) — todas las guardas son silenciosas.
 */
export async function resumeFlowOnPaymentOutcome(opts: {
  companyId: string;
  conversationId?: string | null;
  customerId?: string | null;
  outcome: "approved" | "rejected" | "review";
}): Promise<void> {
  try {
    let convoId = opts.conversationId ?? null;
    if (!convoId && opts.customerId) {
      const last = await prisma.conversation.findFirst({
        where: { companyId: opts.companyId, customerId: opts.customerId, channel: { in: ["whatsapp", "web"] } },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true },
      });
      convoId = last?.id ?? null;
    }
    if (!convoId) return;

    const convo = await prisma.conversation.findUnique({
      where: { id: convoId },
      select: {
        id: true,
        companyId: true,
        customerId: true,
        botPaused: true,
        state: true,
        channel: true,
        customer: { select: { name: true, phone: true } },
      },
    });
    if (!convo || convo.companyId !== opts.companyId) return;
    if (convo.botPaused || (convo.channel !== "whatsapp" && convo.channel !== "web")) return;

    const state = (convo.state as ConversationState) ?? {};
    const fs = flowStateOf(state);
    if (fs.awaitingKind !== "payment" || !fs.awaitingNodeId || !fs.sessionFlowId) return;

    const row = await prisma.chatFlow.findFirst({
      where: { id: fs.sessionFlowId, companyId: convo.companyId },
      select: flowSelect,
    });
    if (!row) return;
    const flow = mapFlow(row);
    const node = nodeById(flow, fs.awaitingNodeId);
    if (!node || node.type !== "validate-payment") return;

    const sender = convo.channel === "web" ? webSender(convo.id) : await loadWhatsappSender(convo.companyId);
    if (!sender) return;
    const company = await prisma.company.findUnique({
      where: { id: convo.companyId },
      select: { timezone: true, messageGapEnabled: true, messageGapSeconds: true },
    });

    await cancelPendingReminders(convo.companyId, convo.customerId, [
      ScheduledMessageType.FLOW_TIMEOUT,
      ScheduledMessageType.PAYMENT_RECHECK,
    ]).catch(() => undefined);

    const io = buildWhatsappFlowIO({
      companyId: convo.companyId,
      customerId: convo.customerId,
      conversationId: convo.id,
      customerPhone: convo.customer.phone,
      customerName: convo.customer.name,
      timezone: company?.timezone ?? "America/Lima",
      gapMs: gapMsFor(company),
      state,
      sender,
      ownerPhone: null,
    });

    try {
      await continueByHandle(flow, node, io, opts.outcome);
    } finally {
      await saveState(convo.id, state);
    }
  } catch (err) {
    console.error("[flows] resumeFlowOnPaymentOutcome:", err instanceof Error ? err.message : err);
  }
}

/**
 * Recheck de pago diferido para un flujo en espera (lo llama recheckPayment del
 * scheduler cuando la conversación tiene un «Validar pago» aguardando).
 */
export async function recheckFlowPayment(msg: ScheduledMessage, state: ConversationState): Promise<void> {
  const fs = flowStateOf(state);
  if (fs.awaitingKind !== "payment" || !fs.awaitingNodeId || !fs.sessionFlowId || !msg.conversationId) return;

  const convo = await prisma.conversation.findUnique({
    where: { id: msg.conversationId },
    select: { id: true, channel: true, customer: { select: { name: true, phone: true } } },
  });
  if (!convo) return;

  const row = await prisma.chatFlow.findFirst({
    where: { id: fs.sessionFlowId, companyId: msg.companyId },
    select: flowSelect,
  });
  if (!row) return;
  const flow = mapFlow(row);
  const node = nodeById(flow, fs.awaitingNodeId);
  if (!node || node.type !== "validate-payment") return;

  const sender = convo.channel === "web" ? webSender(convo.id) : await loadWhatsappSender(msg.companyId);
  if (!sender) return;
  const company = await prisma.company.findUnique({
    where: { id: msg.companyId },
    select: { timezone: true, messageGapEnabled: true, messageGapSeconds: true },
  });

  const io = buildWhatsappFlowIO({
    companyId: msg.companyId,
    customerId: msg.customerId,
    conversationId: convo.id,
    customerPhone: convo.customer.phone,
    customerName: convo.customer.name,
    timezone: company?.timezone ?? "America/Lima",
    gapMs: gapMsFor(company),
    state,
    sender,
    ownerPhone: null,
  });

  const meta = (msg.metadata ?? {}) as { operationCode?: string; expectedAmount?: number; payerName?: string };
  const { tryApprovePayment } = await import("../agent/agent-tools");
  const { buildBotConfig } = await import("../bot/bot.service");
  const config = await buildBotConfig(msg.companyId);
  const result = await tryApprovePayment({
    companyId: msg.companyId,
    customerId: msg.customerId,
    conversationId: convo.id,
    customerPhone: convo.customer.phone,
    config: config as Parameters<typeof tryApprovePayment>[0]["config"],
    state,
    payerName: meta.payerName ?? undefined,
    codes: meta.operationCode ? [meta.operationCode] : [],
    expected: meta.expectedAmount ?? undefined,
    deliver: true,
  });

  try {
    if (result.approved) {
      if (result.customerMessage) await io.emit({ kind: "text", text: result.customerMessage });
      for (const m of result.deliveryOutbox ?? []) await io.emit(m);
      await continueByHandle(flow, node, io, "approved");
    } else {
      await goPaymentReview(flow, node, io);
    }
  } finally {
    await saveState(convo.id, state);
  }
}

// ---------------------------------------------------------------------------
// Bloque «Agendar cita»
// ---------------------------------------------------------------------------

function renderBookingMenu(intro: string, slots: Array<{ label: string }>): string {
  const lines = slots.map((sl, i) => `${i + 1}. ${sl.label}`);
  return `${intro}\n\n${lines.join("\n")}\n\nResponde con el *número* del horario que prefieras 👆`;
}

async function resumeBookingAwaiting(flow: LoadedFlow, node: FlowNode, io: FlowIO, inboundText: string): Promise<void> {
  const fs = flowStateOf(io.state);
  const data = node.data as BookAppointmentData;
  const booking = fs.booking;
  if (!booking?.slots?.length) {
    return continueByHandle(flow, node, io, "no-slots");
  }

  const m = (inboundText ?? "").trim().match(/^(?:opcion\s*)?(\d{1,2})\.?(?:\s|$)/i);
  const num = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(num) || num < 1 || num > booking.slots.length) {
    await io.emit({
      kind: "text",
      text: "No te entendí 🙏 responde con el *número* del horario (por ejemplo: *1*).",
    });
    await io.emit({ kind: "text", text: renderBookingMenu("Estos son los horarios disponibles 📅", booking.slots) });
    await armBookingTimeout(flow, node, io);
    pushTrace(io, node, "booking:retry");
    return;
  }

  const chosen = booking.slots[num - 1];
  const startsAt = new Date(chosen.startsAt);

  if (io.simulate) {
    const check = await isSlotAvailable(io.companyId, booking.productId, startsAt).catch(() => ({ ok: true }));
    if (!(check as { ok: boolean }).ok) {
      await io.emit({ kind: "text", text: "(simulación) Ese horario ya no está libre; elige otro." });
      await armBookingTimeout(flow, node, io);
      return;
    }
    fs.variables = {
      ...(fs.variables ?? {}),
      cita_fecha: chosen.label,
      cita_codigo: "SIM-0001",
      ...(data.saveVariable?.trim() ? { [data.saveVariable.trim()]: chosen.label } : {}),
    };
    pushTrace(io, node, "(simulación) cita validada, no se guarda");
    return continueByHandle(flow, node, io, "booked");
  }

  try {
    const created = await createBooking({
      companyId: io.companyId,
      customerId: io.customerId,
      productId: booking.productId,
      startsAt: chosen.startsAt,
      source: "flow",
    });
    const when = created.startsAt ? formatSlotLabel(created.startsAt, io.timezone) : chosen.label;
    fs.variables = {
      ...(fs.variables ?? {}),
      cita_fecha: when,
      cita_codigo: created.bookingCode ?? "",
      ...(data.saveVariable?.trim() ? { [data.saveVariable.trim()]: when } : {}),
    };
    io.state.status = "RESERVA_SOLICITADA";
    await io.notifyOwner(
      `📅 Nueva CITA (${io.customerPhone}): ${created.product?.name ?? "servicio"} — ${when}` +
        `${created.bookingCode ? ` · ${created.bookingCode}` : ""}.`,
    );
    pushTrace(io, node, "booking:booked");
    return continueByHandle(flow, node, io, "booked");
  } catch (err) {
    // Carrera: el hueco se ocupó entre el menú y la elección.
    const attempts = (booking.attempts ?? 0) + 1;
    if (attempts > 2) {
      pushTrace(io, node, "booking:sin-alternativas");
      return continueByHandle(flow, node, io, "no-slots");
    }
    let fresh: Array<{ startsAt: string; label: string }> = [];
    try {
      const res = await getAvailableSlots(io.companyId, booking.productId, { limit: 6 });
      fresh = res.slots.map((sl) => ({ startsAt: sl.startsAt, label: sl.label }));
    } catch {
      /* ignore */
    }
    if (!fresh.length) {
      pushTrace(io, node, "booking:sin-alternativas");
      return continueByHandle(flow, node, io, "no-slots");
    }
    fs.booking = { productId: booking.productId, slots: fresh, attempts };
    const reason = err instanceof Error ? err.message : reasonMessage();
    await io.emit({ kind: "text", text: `${reason} 😅 Te paso los disponibles:` });
    await io.emit({ kind: "text", text: renderBookingMenu("Horarios actualizados 📅", fresh) });
    await armBookingTimeout(flow, node, io);
    pushTrace(io, node, "booking:slot-race");
    return;
  }
}

// ---------------------------------------------------------------------------
// Construcción de FlowIO real (WhatsApp)
// ---------------------------------------------------------------------------

interface WhatsappIOOpts {
  companyId: string;
  customerId: string;
  conversationId: string;
  customerPhone: string;
  customerName: string | null;
  timezone: string;
  state: ConversationState;
  sender: WhatsappSender;
  /** Número del dueño para avisos (handoff); si null se resuelve de PaymentConfig/Company. */
  ownerPhone: string | null;
  /** Pausa (ms) entre bloques encadenados; default OUTBOX_GAP_MS. */
  gapMs?: number;
}

function buildWhatsappFlowIO(opts: WhatsappIOOpts): FlowIO {
  const ids = {
    companyId: opts.companyId,
    customerId: opts.customerId,
    conversationId: opts.conversationId,
  };
  const to = opts.customerPhone.replace(/\D/g, "");

  return {
    companyId: opts.companyId,
    customerId: opts.customerId,
    conversationId: opts.conversationId,
    customerPhone: opts.customerPhone,
    customerName: opts.customerName,
    timezone: opts.timezone,
    gapMs: opts.gapMs,
    state: opts.state,
    async emit(msg) {
      await deliver(opts.sender, to, msg, ids);
    },
    async notifyOwner(text) {
      let owner = opts.ownerPhone;
      if (!owner) {
        const [pay, company] = await Promise.all([
          prisma.paymentConfig.findUnique({
            where: { companyId: opts.companyId },
            select: { notificationPhone: true },
          }),
          prisma.company.findUnique({
            where: { id: opts.companyId },
            select: { adminPhone: true },
          }),
        ]);
        owner = pay?.notificationPhone || company?.adminPhone || null;
      }
      const ownerTo = (owner ?? "").replace(/\D/g, "");
      if (!ownerTo) return;
      try {
        await sendText(opts.sender, ownerTo, text);
      } catch {
        /* best-effort */
      }
    },
    async pauseBot() {
      await setBotPaused(opts.companyId, opts.conversationId, true);
    },
    async scheduleTimeout(flowId, nodeId, minutes) {
      await prisma.scheduledMessage.create({
        data: {
          companyId: opts.companyId,
          customerId: opts.customerId,
          conversationId: opts.conversationId,
          type: ScheduledMessageType.FLOW_TIMEOUT,
          sendAt: minutesFromNow(minutes),
          body: "",
          metadata: {
            kind: "flow-timeout",
            conversationId: opts.conversationId,
            flowId,
            nodeId,
          } as Prisma.InputJsonValue,
        },
      });
    },
    async cancelTimeouts() {
      await cancelPendingReminders(opts.companyId, opts.customerId, [ScheduledMessageType.FLOW_TIMEOUT]);
    },
    async scheduleReminderMsg(minutes, body) {
      await scheduleReminder({
        companyId: opts.companyId,
        customerId: opts.customerId,
        conversationId: opts.conversationId,
        type: ScheduledMessageType.CUSTOM,
        sendAt: minutesFromNow(minutes),
        body,
        // Recordatorios de flujo también respetan el horario hábil del tenant.
        timezone: opts.timezone,
      });
    },
  };
}

/** FlowIO real construido desde el TurnContext del pipeline del agente. */
export function buildRealFlowIO(ctx: TurnContext, sender: WhatsappSender): FlowIO {
  const config = ctx.config as {
    business: { timezone?: string; messageGapEnabled?: boolean; messageGapSeconds?: number };
    payment?: { notification?: { whatsappPhone?: string | null } };
  };
  return buildWhatsappFlowIO({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    conversationId: ctx.conversationId,
    customerPhone: ctx.customerPhone,
    customerName: null, // se resuelve abajo de forma lazy en renderTemplate vía override
    timezone: config.business.timezone ?? "America/Lima",
    gapMs: gapMsFor(config.business),
    state: ctx.state,
    sender,
    ownerPhone: config.payment?.notification?.whatsappPhone ?? null,
  });
}
