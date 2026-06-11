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
import type { TurnContext, OutboxMessage } from "./agent-tools";
import { summarizeCart } from "./cart.service";
import { resolveReminderSequence, type ReminderType } from "./reminder-templates";

const SIM_PHONE = "SIMULADOR"; // identidad del "cliente" de simulación (no es un número real)

export interface SimMessage {
  role: "user" | "assistant";
  text: string;
  mediaUrl?: string | null;
  mediaKind?: string | null;
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

async function loadSimConversation(companyId: string) {
  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone: SIM_PHONE } },
    update: {},
    create: { companyId, phone: SIM_PHONE, status: "activo", lastInteractionAt: new Date(), metadata: { origin: "simulator" } },
    select: { id: true },
  });
  const convo = await prisma.conversation.upsert({
    where: { companyId_customerId_channel: { companyId, customerId: customer.id, channel: "sim" } },
    update: {},
    create: { companyId, customerId: customer.id, channel: "sim", state: {} },
    select: { id: true, state: true },
  });
  return { customerId: customer.id, conversationId: convo.id, state: (convo.state as ConversationState) ?? {} };
}

function outboxText(m: OutboxMessage): string {
  return m.kind === "media" ? (m.caption ?? "") : (m.text ?? "");
}

/** Procesa un mensaje del "cliente" simulado y devuelve las respuestas del bot. */
export async function simulateTurn(
  companyId: string,
  message: string,
): Promise<{ replies: SimMessage[]; reminders: SimReminderPreview[] }> {
  const config = await buildBotConfig(companyId);
  const sim = await loadSimConversation(companyId);

  // Persistir el mensaje del cliente (para el historial del turno).
  await prisma.conversationMessage.create({
    data: { companyId, customerId: sim.customerId, conversationId: sim.conversationId, role: "USER", message },
  });

  const history = await buildHistory(sim.conversationId);
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
  };

  let finalText = "";
  try {
    finalText = await runAgentTurn(ctx, history);
  } catch (err) {
    finalText = "Disculpa, tuve un inconveniente. (simulación)";
    console.error("[simulate] runAgentTurn falló:", err instanceof Error ? err.message : err);
  }

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
    replies.push({ role: "assistant", text, mediaUrl: m.mediaUrl ?? null, mediaKind: m.mediaKind ?? null });
  }
  if (finalText) {
    await prisma.conversationMessage.create({
      data: { companyId, customerId: sim.customerId, conversationId: sim.conversationId, role: "ASSISTANT", message: finalText },
    });
    replies.push({ role: "assistant", text: finalText });
  }

  await saveState(sim.conversationId, ctx.state);
  const reminders = await previewReminders(companyId, sim.customerId, ctx.state, config);
  return { replies, reminders };
}

/** Mensajes actuales de la conversación de simulación (para cargar el chat al abrir). */
export async function getSimMessages(companyId: string): Promise<SimMessage[]> {
  const sim = await loadSimConversation(companyId);
  const rows = await prisma.conversationMessage.findMany({
    where: { companyId, conversationId: sim.conversationId, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { role: true, message: true, mediaUrl: true },
  });
  return rows.map((r) => ({
    role: r.role === "USER" ? "user" : "assistant",
    text: r.message ?? "",
    mediaUrl: r.mediaUrl,
  }));
}

/** Reinicia la conversación de simulación (historial, carrito y estado). */
export async function resetSim(companyId: string): Promise<void> {
  const sim = await loadSimConversation(companyId);
  await resetConversation(companyId, sim.conversationId, sim.customerId);
}
