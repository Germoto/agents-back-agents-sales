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

const SIM_PHONE = "SIMULADOR"; // identidad del "cliente" de simulación (no es un número real)

export interface SimMessage {
  role: "user" | "assistant";
  text: string;
  mediaUrl?: string | null;
  mediaKind?: string | null;
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
export async function simulateTurn(companyId: string, message: string): Promise<{ replies: SimMessage[] }> {
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
  return { replies };
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
