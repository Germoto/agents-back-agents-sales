/**
 * Entrega al aprobar desde el panel / copiloto (botón «Aprobar» y
 * aprobar_comprobante): hasta ahora aprobar solo aprobaba, y si el chat estaba en
 * atención humana (p. ej. tras un reintento de pago sin match) nadie enviaba el
 * acceso. Reusa la misma entrega que el agente al validar (assignAndBuildDelivery
 * + flushOutbox): STATIC/POOL_AUTO se envían; MANUAL queda para el asesor.
 * Best-effort: nunca deshace la aprobación.
 */

import { ScheduledMessageType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { buildBotConfig } from "../bot/bot.service";
import { loadWhatsappSender, sendText, webSender } from "../agent/outbound";
import { assignAndBuildDelivery, autoSaleNotice, muteCustomerToHuman } from "../agent/agent-tools";
import { flushOutbox, gapMsFor } from "../agent/delivery";
import { getConversationRuntime, recordMessage, saveState, type ConversationState } from "../agent/conversation.service";
import { cancelPendingReminders } from "../scheduler/scheduler.service";

export type ApprovedReceiptDelivery = {
  /** true = se enviaron mensajes de entrega por el chat. */
  delivered: boolean;
  /** Mensajes enviados. */
  sent: number;
  /** Por qué no se entregó (ya entregado, sin producto/cliente, sin chat, entrega manual…). */
  reason: string | null;
  manualNeeded: string[];
  outOfStock: string[];
};

const skip = (reason: string): ApprovedReceiptDelivery => ({ delivered: false, sent: 0, reason, manualNeeded: [], outOfStock: [] });

export async function deliverApprovedReceipt(companyId: string, receiptId: string): Promise<ApprovedReceiptDelivery> {
  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id: receiptId, companyId },
    select: { id: true, status: true, productId: true, customerId: true, digitalSaleId: true, customer: { select: { phone: true } } },
  });
  if (!receipt) return skip("comprobante no encontrado");
  if (receipt.status !== "APROBADO") return skip(`comprobante ${receipt.status}, no aprobado`);
  if (!receipt.productId) return skip("sin producto asociado: asócialo y entrega con la respuesta rápida");
  if (!receipt.customerId) return skip("sin cliente asociado");

  const conversation = await prisma.conversation.findFirst({
    where: { companyId, customerId: receipt.customerId, channel: { in: ["whatsapp", "web"] } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (!conversation) return skip("el cliente no tiene chat");
  const runtime = await getConversationRuntime(conversation.id);
  if (!runtime) return skip("el cliente no tiene chat");
  const state = (runtime.state ?? {}) as ConversationState;
  const purchased = Array.isArray(state.purchasedProductIds) ? state.purchasedProductIds : [];
  if (state.status === "ENTREGADO" && purchased.includes(receipt.productId)) return skip("ya estaba entregado en el chat");

  const config = await buildBotConfig(companyId);
  const product = config.products.find((p) => p.id === receipt.productId);
  if (!product) return skip("producto no encontrado");
  if (product.productType !== "digital" || !product.digitalDelivery) return skip("el producto no tiene entrega digital configurada");

  const waSender = await loadWhatsappSender(companyId);
  const sender = runtime.channel === "web" ? webSender(conversation.id) : waSender;
  const to = (receipt.customer?.phone ?? "").replace(/\D/g, "");
  if (!sender || (runtime.channel !== "web" && !to)) return skip("WhatsApp no configurado");

  const del = await assignAndBuildDelivery(config, [receipt.productId], {
    companyId,
    customerId: receipt.customerId,
    conversationId: conversation.id,
  });
  const ids = { companyId, customerId: receipt.customerId, conversationId: conversation.id };

  // Solo cuenta como entrega si hubo acceso real (STATIC/POOL_AUTO). Con entrega
  // MANUAL el builder arma un "te lo envía un asesor" que aquí sobra: quien aprueba
  // desde el panel es ese asesor y lo manda con la respuesta rápida.
  if (!del.delivered.length || !del.outbox.length) {
    const reason = del.manualNeeded.length
      ? `entrega MANUAL configurada para ${del.manualNeeded.join(", ")}: envíala con la respuesta rápida`
      : del.outOfStock.length
        ? `sin stock en inventario: ${del.outOfStock.join(", ")}`
        : "el producto no tiene mensaje de entrega";
    await recordMessage({ ...ids, role: "SYSTEM", message: `✅ Comprobante aprobado. Sin entrega automática: ${reason}.`, rawPayload: { source: "approve-delivery" } }).catch(() => undefined);
    return { delivered: false, sent: 0, reason, manualNeeded: del.manualNeeded, outOfStock: del.outOfStock };
  }

  const r = await flushOutbox(sender, to, del.outbox, ids, gapMsFor(config.business));
  if (del.storeInvite) await flushOutbox(sender, to, [del.storeInvite], ids, gapMsFor(config.business));

  // Mismo estado que deja el agente al entregar.
  state.status = "ENTREGADO";
  state.purchasedProductIds = Array.from(new Set([...purchased, receipt.productId]));
  state.activeOffer = null;
  state.pendingRecheckAt = null;
  if (del.offeredCrossSellId) state.offeredCrossSellProductId = del.offeredCrossSellId;
  await saveState(conversation.id, state);
  if (receipt.digitalSaleId) {
    await prisma.digitalSale.update({ where: { id: receipt.digitalSaleId }, data: { status: "ENTREGADO", deliveredAt: new Date() } }).catch(() => undefined);
  }
  await cancelPendingReminders(companyId, receipt.customerId, [
    ScheduledMessageType.ABANDONED_CART,
    ScheduledMessageType.LEFT_ON_READ,
    ScheduledMessageType.OFFER_COUNTDOWN,
  ]).catch(() => undefined);
  await recordMessage({
    ...ids,
    role: "SYSTEM",
    message: `📦 Entrega enviada al aprobar el comprobante (${r.sent} mensaje${r.sent === 1 ? "" : "s"}${r.failed ? `, ${r.failed} fallido${r.failed === 1 ? "" : "s"}` : ""}).`,
    rawPayload: { source: "approve-delivery" },
  }).catch(() => undefined);

  // Igual que la auto-entrega del agente: pausa por configuración del producto y aviso de ventas por inventario.
  if (del.shouldPauseHuman) await muteCustomerToHuman(companyId, conversation.id, to).catch(() => undefined);
  if (del.autoSales.length && waSender) {
    const adminPhone = (config.payment.notification?.whatsappPhone || config.business.adminPhone || "").replace(/\D/g, "");
    if (adminPhone) {
      for (const s of del.autoSales) await sendText(waSender, adminPhone, autoSaleNotice(s, to)).catch(() => undefined);
    }
  }
  console.log(`[receipts] entrega al aprobar: ${r.sent} enviados (receipt=${receipt.id} conv=${conversation.id})`);
  return { delivered: r.sent > 0, sent: r.sent, reason: r.sent ? null : "no se pudo enviar", manualNeeded: del.manualNeeded, outOfStock: del.outOfStock };
}
