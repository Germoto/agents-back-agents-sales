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
import { loadWhatsappSender, sendText, type WhatsappSender } from "../agent/outbound";
import { deliver, sleep, OUTBOX_GAP_MS } from "../agent/delivery";
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
  flattenListOptions,
  isSendNode,
} from "./flow-types";

// ---------------------------------------------------------------------------
// Estado de sesión (namespace `flow` dentro de Conversation.state)
// ---------------------------------------------------------------------------

export interface FlowSessionState {
  sessionFlowId?: string;
  awaitingNodeId?: string;
  awaitingKind?: "reply" | "options";
  variables?: Record<string, string>;
  /** flowId -> ISO del último disparo (para reactivationMinutes). */
  lastTriggeredAt?: Record<string, string>;
}

function flowStateOf(state: ConversationState): FlowSessionState {
  if (!state.flow || typeof state.flow !== "object") state.flow = {};
  return state.flow as FlowSessionState;
}

function clearSession(fs: FlowSessionState): void {
  delete fs.sessionFlowId;
  delete fs.awaitingNodeId;
  delete fs.awaitingKind;
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

function matchAnswersOption(data: AnswersData, inbound: string): string | null {
  const input = normalize(inbound);
  if (!input) return null;
  for (const opt of data.options ?? []) {
    const target = normalize(opt.detectText ?? "");
    if (!target) continue;
    const mode = opt.detectMode ?? "contains";
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
  return null;
}

function matchListOption(data: ListData, inbound: string): string | null {
  const input = normalize(inbound);
  if (!input) return null;
  const flat = flattenListOptions(data);
  // 1) por número global ("2", "2.", "opción 2")
  const numMatch = input.match(/^(?:opcion\s*)?(\d{1,2})\.?$/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    const byNumber = flat.find((o) => o.number === n);
    if (byNumber) return byNumber.id;
  }
  // 2) por texto del label (igual, o contenido si el label es significativo)
  for (const opt of flat) {
    const label = normalize(opt.label ?? "");
    if (!label) continue;
    if (input === label) return opt.id;
    if (label.length >= 3 && input.includes(label)) return opt.id;
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
  const data = node.data as AnswersData | ListData;
  const minutes = Number(data.timeoutMinutes ?? 0);
  if (minutes > 0 && edgeFrom(flow, node.id, "timeout")) {
    await io.scheduleTimeout(flow.id, node.id, minutes);
    pushTrace(io, node, `timeout-armed:${minutes}m`);
  }
}

async function pause(io: FlowIO): Promise<void> {
  if (!io.simulate) await sleep(OUTBOX_GAP_MS);
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
        if (data.minutes > 0 && data.message?.trim()) {
          await io.scheduleReminderMsg(data.minutes, renderTemplate(data.message.trim(), io));
          pushTrace(io, node, `reminder:${data.minutes}m`);
        }
        break;
      }
    }

    // Encadenar por "next" (send-*, reminder)
    const replyEdge = isSendNode(node.type) ? edgeFrom(activeFlow, node.id, "reply") : undefined;
    if (replyEdge) {
      fs.awaitingNodeId = node.id;
      fs.awaitingKind = "reply";
      fs.sessionFlowId = activeFlow.id;
      pushTrace(io, node, "awaiting-reply");
      return;
    }
    const nextEdge = edgeFrom(activeFlow, node.id, "next");
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
  if (!convo || convo.botPaused || convo.channel !== "whatsapp") return;

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

  const sender = await loadWhatsappSender(convo.companyId);
  if (!sender) return;

  const company = await prisma.company.findUnique({
    where: { id: convo.companyId },
    select: { timezone: true },
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
      });
    },
  };
}

/** FlowIO real construido desde el TurnContext del pipeline del agente. */
export function buildRealFlowIO(ctx: TurnContext, sender: WhatsappSender): FlowIO {
  const config = ctx.config as {
    business: { timezone?: string };
    payment?: { notification?: { whatsappPhone?: string | null } };
  };
  return buildWhatsappFlowIO({
    companyId: ctx.companyId,
    customerId: ctx.customerId,
    conversationId: ctx.conversationId,
    customerPhone: ctx.customerPhone,
    customerName: null, // se resuelve abajo de forma lazy en renderTemplate vía override
    timezone: config.business.timezone ?? "America/Lima",
    state: ctx.state,
    sender,
    ownerPhone: config.payment?.notification?.whatsappPhone ?? null,
  });
}
