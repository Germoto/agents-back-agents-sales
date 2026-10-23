/**
 * Simulador del agente para el panel (sección Pruebas). Corre el MISMO runtime
 * (runAgentTurn + tools) contra una conversación de simulación dedicada por
 * empresa (canal "sim"), pero NO envía nada por WhatsApp ni programa recordatorios,
 * y los tools que escriben datos compartidos (validar_pago, pedidos, reservas) se
 * stubean vía ctx.simulate. Devuelve lo que el bot respondería.
 */

import { prisma } from "../../lib/prisma";
import { buildBotConfig } from "../bot/bot.service";
import { runAgentTurn } from "./agent-runtime";
import { buildHistory, saveState, resetConversation, type ConversationState } from "./conversation.service";
import { runFlowTurn, trailingUserText, getCustomerFlowVars, type FlowIO, type FlowTraceEntry, type FlowTurnResult } from "../flows/flow-engine";
import { shouldDropFinalTextAfterPayment, type TurnContext, type OutboxMessage } from "./agent-tools";
import { summarizeCart } from "./cart.service";
import { resolveReminderSequence, applySpintax, type ReminderType } from "./reminder-templates";
import { resolveAdCatalog, adCatalogEntryFor } from "../ad-catalog/ad-catalog.service";

const SIM_PHONE = "SIMULADOR"; // identidad del "cliente" de simulación (no es un número real)

/**
 * Modo del simulador. "AI" simula SOLO el agente IA y "FLOW" solo los flujos,
 * sin importar el botMode de la empresa. Cada modo usa su propia conversación
 * (canal "sim" vs "sim-flow") para que no se mezclen historial ni estado.
 */
export type SimMode = "AI" | "FLOW" | "HYBRID";

function simChannel(mode: SimMode): string {
  return mode === "FLOW" ? "sim-flow" : mode === "HYBRID" ? "sim-hybrid" : "sim";
}

export interface SimMessage {
  role: "user" | "assistant";
  text: string;
  mediaUrl?: string | null;
  mediaKind?: string | null;
  /** Quién respondió (modo HYBRID): el flujo o el agente IA. */
  source?: "flow" | "agent";
}

export interface SimReminderPreview {
  type: ReminderType;
  label: string;
  steps: Array<{ delaySeconds: number; text: string; mediaUrl?: string | null }>;
}

const REMINDER_LABEL: Record<ReminderType, string> = {
  abandonedCart: "Abandono de carrito",
  leftOnRead: "Dejado en visto",
};

/**
 * Calcula (sin programar ni enviar) qué secuencias de recordatorios dispararía el
 * estado actual, para mostrarlas como vista previa en el simulador. Misma lógica de
 * disparo que scheduleAutoReminders.
 */
async function previewReminders(
  companyId: string,
  customerId: string,
  state: ConversationState,
  config: Awaited<ReturnType<typeof buildBotConfig>>,
): Promise<SimReminderPreview[]> {
  const status = state.status ?? "";
  if (["ENTREGADO", "PEDIDO_REGISTRADO", "RESERVA_SOLICITADA", "ASESOR_HUMANO"].includes(status)) return [];

  const cart = await summarizeCart(companyId, customerId);
  const pid = cart.items[0]?.productId ?? state.selectedProductId ?? null;
  const product = pid ? config.products.find((p) => p.id === pid || p.slug === pid) : undefined;
  const vars = {
    nombre: "",
    producto: product?.name,
    total: cart.items.length ? cart.totalText : undefined,
    negocio: config.business.name,
  };
  const followup = config.agent.followupConfig;
  const productReminder = (product as { reminderConfig?: unknown } | undefined)?.reminderConfig;

  const types: ReminderType[] = [];
  if (status === "ESPERANDO_PAGO" && (cart.items.length || state.selectedProductId)) types.push("abandonedCart");
  types.push("leftOnRead");

  const out: SimReminderPreview[] = [];
  for (const type of types) {
    const seq = resolveReminderSequence(followup, type, productReminder, vars);
    if (!seq.enabled || !seq.steps.length) continue;
    out.push({
      type,
      label: REMINDER_LABEL[type],
      steps: seq.steps.map((s) => ({ delaySeconds: s.delaySeconds, text: s.message, mediaUrl: s.mediaUrl })),
    });
  }
  return out;
}

async function loadSimConversation(companyId: string, mode: SimMode) {
  const channel = simChannel(mode);
  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone: SIM_PHONE } },
    update: {},
    create: { companyId, phone: SIM_PHONE, status: "activo", lastInteractionAt: new Date(), metadata: { origin: "simulator" } },
    select: { id: true },
  });
  const convo = await prisma.conversation.upsert({
    where: { companyId_customerId_channel: { companyId, customerId: customer.id, channel } },
    update: {},
    create: { companyId, customerId: customer.id, channel, state: {} },
    select: { id: true, state: true },
  });
  return { customerId: customer.id, conversationId: convo.id, state: (convo.state as ConversationState) ?? {} };
}

// Igual que deliver(): las variantes {a|b|c} se muestran resueltas (una combinación
// al azar), tal como las vería el cliente — el simulador no pasa por deliver().
function outboxText(m: OutboxMessage): string {
  return applySpintax(m.kind === "media" ? (m.caption ?? "") : (m.text ?? ""));
}

/**
 * Procesa un mensaje del "cliente" simulado y devuelve las respuestas del bot.
 * `modeParam` fuerza qué se simula ("AI" = agente IA aunque la empresa esté en
 * modo flujos, y viceversa); si no viene, se usa el botMode de la empresa.
 */
export async function simulateTurn(
  companyId: string,
  message: string,
  modeParam?: SimMode,
  opts?: { adSourceId?: string },
): Promise<{ replies: SimMessage[]; reminders: SimReminderPreview[]; trace?: FlowTraceEntry[]; notices?: string[] }> {
  const config = await buildBotConfig(companyId);
  const mode: SimMode = modeParam ?? (config.business.botMode === "FLOW" ? "FLOW" : config.business.botMode === "HYBRID" ? "HYBRID" : "AI");
  const sim = await loadSimConversation(companyId, mode);

  // "Llega desde un anuncio": simular el primer mensaje atribuido (señal para
  // el disparador onAdLead). Las acciones CRM del anuncio solo se anotan.
  const adNotes: FlowTraceEntry[] = [];
  if (opts?.adSourceId) {
    const entry = adCatalogEntryFor(await resolveAdCatalog(companyId), opts.adSourceId, opts.adSourceId);
    sim.state.adLead = { adSourceId: opts.adSourceId, adTitle: opts.adSourceId, entryId: entry?.id ?? null, pending: true, at: new Date().toISOString() };
    adNotes.push({
      nodeId: "-",
      type: "start",
      event: entry
        ? `lead de anuncio «${entry.description}»${entry.tagIds.length || entry.crmColumnId ? " — se aplicarían sus etiquetas/columna del CRM (simulado)" : ""}`
        : `lead de anuncio «${opts.adSourceId}» (no está en el catálogo)`,
    });
  }

  // Persistir el mensaje del cliente (para el historial del turno).
  await prisma.conversationMessage.create({
    data: { companyId, customerId: sim.customerId, conversationId: sim.conversationId, role: "USER", message },
  });

  const history = await buildHistory(sim.conversationId);

  // Modo FLOW: el simulador corre el motor de flujos real, sin enviar por
  // WhatsApp ni programar timeouts/recordatorios (se anotan en el trace).
  // Modo HYBRID: igual que producción, si el flujo no habló sigue el agente IA.
  let hybridTrace: FlowTraceEntry[] | undefined;
  let customerFlowVars: Record<string, string> | null = null;
  if (mode === "FLOW" || mode === "HYBRID") {
    const replies: SimMessage[] = [];
    const trace: FlowTraceEntry[] = [...adNotes];
    const persistReply = async (m: OutboxMessage) => {
      const text = outboxText(m);
      await prisma.conversationMessage.create({
        data: {
          companyId,
          customerId: sim.customerId,
          conversationId: sim.conversationId,
          role: "ASSISTANT",
          message: text || null,
          mediaUrl: m.mediaUrl ?? null,
          mediaType: m.kind === "media" ? m.mediaKind ?? "image" : null,
        },
      });
      replies.push({ role: "assistant", text, mediaUrl: m.mediaUrl ?? null, mediaKind: m.mediaKind ?? null, source: "flow" });
    };
    const io: FlowIO = {
      companyId,
      customerId: sim.customerId,
      conversationId: sim.conversationId,
      customerPhone: SIM_PHONE,
      customerName: "Cliente de prueba",
      timezone: config.business.timezone,
      state: sim.state,
      emit: persistReply,
      notifyOwner: async (text) => {
        trace.push({ nodeId: "-", type: "handoff", event: `notify-owner: ${text.slice(0, 80)}` });
      },
      pauseBot: async () => {
        trace.push({ nodeId: "-", type: "handoff", event: "bot-paused (simulado)" });
      },
      scheduleTimeout: async (_flowId, nodeId, minutes) => {
        trace.push({ nodeId, type: "timeout", event: `se programaría timeout de ${minutes} min` });
      },
      cancelTimeouts: async () => {},
      scheduleReminderMsg: async (minutes, body) => {
        trace.push({ nodeId: "-", type: "reminder", event: `se programaría recordatorio en ${minutes} min: ${body.slice(0, 60)}` });
      },
      simulate: true,
      trace,
    };
    const takeover = mode === "HYBRID" && Boolean((sim.state.flow as { aiTakeover?: unknown } | undefined)?.aiTakeover);
    let r: FlowTurnResult | null = null;
    try {
      r = await runFlowTurn(io, trailingUserText(history), history, { onlyExplicit: takeover });
    } catch (err) {
      console.error("[simulate] runFlowTurn falló:", err instanceof Error ? err.message : err);
    }
    await saveState(sim.conversationId, io.state);
    const flowSpoke = Boolean(r && (r.paused || r.awaiting || r.emitted > 0));
    if (mode === "FLOW" || flowSpoke) return { replies, reminders: [], trace };
    trace.push({
      nodeId: "-",
      type: "to-agent",
      event: r?.toAgent ? "el flujo pasó la conversación al agente IA" : "ningún flujo respondió: responde el agente IA",
    });
    hybridTrace = trace;
    // En simulación las variables no se persisten en la ficha: usar las del estado.
    const vars = (sim.state.flow as { variables?: Record<string, string> } | undefined)?.variables ?? null;
    customerFlowVars = vars && Object.keys(vars).length ? vars : await getCustomerFlowVars(sim.customerId);
  }
  const ctx: TurnContext = {
    companyId,
    customerId: sim.customerId,
    conversationId: sim.conversationId,
    customerPhone: SIM_PHONE,
    config,
    state: sim.state,
    outbox: [],
    reminders: [],
    adminNotices: [],
    simulate: true,
    customerFlowVars,
  };

  let finalText = "";
  try {
    finalText = await runAgentTurn(ctx, history);
  } catch (err) {
    finalText = "Disculpa, tuve un inconveniente. (simulación)";
    console.error("[simulate] runAgentTurn falló:", err instanceof Error ? err.message : err);
  }
  if (shouldDropFinalTextAfterPayment(ctx, finalText, trailingUserText(history))) finalText = "";
  finalText = applySpintax(finalText);

  const replies: SimMessage[] = [];
  for (const m of ctx.outbox) {
    const text = outboxText(m);
    await prisma.conversationMessage.create({
      data: {
        companyId,
        customerId: sim.customerId,
        conversationId: sim.conversationId,
        role: "ASSISTANT",
        message: text || null,
        mediaUrl: m.mediaUrl ?? null,
      },
    });
    replies.push({ role: "assistant", text, mediaUrl: m.mediaUrl ?? null, mediaKind: m.mediaKind ?? null, source: "agent" });
  }
  if (finalText) {
    await prisma.conversationMessage.create({
      data: { companyId, customerId: sim.customerId, conversationId: sim.conversationId, role: "ASSISTANT", message: finalText },
    });
    replies.push({ role: "assistant", text: finalText, source: "agent" });
  }

  await saveState(sim.conversationId, ctx.state);
  const reminders = await previewReminders(companyId, sim.customerId, ctx.state, config);
  // Notas de sistema (p. ej. "pasaría a atención humana"): el simulador no ejecuta
  // los efectos reales pero deja constancia de lo que ocurriría en producción.
  return { replies, reminders, notices: ctx.adminNotices, ...(hybridTrace ? { trace: hybridTrace } : {}) };
}

/** Mensajes actuales de la conversación de simulación (para cargar el chat al abrir). */
export async function getSimMessages(companyId: string, modeParam?: SimMode): Promise<SimMessage[]> {
  const mode: SimMode = modeParam ?? "AI";
  const sim = await loadSimConversation(companyId, mode);
  const rows = await prisma.conversationMessage.findMany({
    where: { companyId, conversationId: sim.conversationId, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "asc" },
    take: 200,
    // mediaType es imprescindible: sin él el panel no sabe si el mensaje trae
    // un adjunto real y pintaba "archivo adjunto" en mensajes de solo texto.
    select: { role: true, message: true, mediaUrl: true, mediaType: true },
  });
  return rows.map((r) => ({
    role: r.role === "USER" ? "user" : "assistant",
    text: r.message ?? "",
    mediaUrl: r.mediaUrl,
    mediaKind: r.mediaType,
  }));
}

/** Reinicia la conversación de simulación (historial, carrito y estado). */
export async function resetSim(companyId: string, modeParam?: SimMode): Promise<void> {
  const mode: SimMode = modeParam ?? "AI";
  const sim = await loadSimConversation(companyId, mode);
  await resetConversation(companyId, sim.conversationId, sim.customerId);
}
