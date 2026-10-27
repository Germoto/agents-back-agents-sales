import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { resolveAdDescriptions, adInfoFor } from "../ad-catalog/ad-catalog.service";

/**
 * Elimina un lead/cliente POR COMPLETO. El cascade de Prisma borra sus CrmCards
 * (todos los CRM), conversaciones, mensajes, etiquetas, valores de negocio,
 * carritos, recordatorios, notas y suscripciones. Los PaymentReceipt quedan
 * huérfanos (customerId=null, onDelete SetNull) — siguen visibles en Comprobantes.
 * Bloquea SOLO si el cliente tiene una venta aprobada (comprobante APROBADO).
 */
export async function deleteCustomer(companyId: string, customerId: string): Promise<void> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);

  const approved = await prisma.paymentReceipt.count({
    where: { companyId, customerId, status: "APROBADO" },
  });
  if (approved > 0) {
    throw new AppError("No puedes eliminar este lead: tiene una venta aprobada (comprobante APROBADO).", 409);
  }

  // Conversaciones del cliente: para avisar a las vistas abiertas tras el borrado.
  const convos = await prisma.conversation.findMany({
    where: { companyId, customerId },
    select: { id: true },
  });

  await prisma.customer.delete({ where: { id: customerId } });

  // Refrescar CRM y Conversaciones en tiempo real.
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CRM_UPDATED, { crmId: null });
  for (const c of convos) {
    socketService.emitToCompany(companyId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
      conversationId: c.id,
      deleted: true,
    });
  }
}

/**
 * Elimina en lote varios leads (selección masiva del CRM). Best-effort por item:
 * los que tienen venta aprobada se omiten y se reportan con su motivo.
 */
export async function deleteCustomersBulk(
  companyId: string,
  ids: string[],
): Promise<{ deleted: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const clean = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
  const deleted: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const id of clean) {
    try {
      await deleteCustomer(companyId, id);
      deleted.push(id);
    } catch (err) {
      skipped.push({ id, reason: err instanceof AppError ? err.message : "No se pudo eliminar" });
    }
  }
  return { deleted, skipped };
}

export async function listCustomers(companyId: string) {
  return prisma.customer.findMany({
    where: { companyId },
    include: {
      selectedProduct: {
        select: {
          id: true,
          slug: true,
          name: true,
        },
      },
    },
    orderBy: { lastInteractionAt: "desc" },
  });
}

/** Ficha completa de un contacto para el panel de Conversaciones. */
export async function getCustomer(companyId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    include: {
      selectedProduct: { select: { id: true, slug: true, name: true } },
      deals: { orderBy: { createdAt: "desc" }, select: { id: true, description: true, amount: true, createdAt: true } },
      tagLinks: { select: { tag: { select: { id: true, name: true, color: true } } } },
    },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);
  const { tagLinks, deals, ...rest } = customer;
  const adMap = await resolveAdDescriptions(companyId);
  return {
    ...rest,
    // Anuncio de origen (atribución CTWA) con la descripción del catálogo resuelta.
    ad: adInfoFor(adMap, customer.adSourceId, customer.adTitle),
    tags: tagLinks.map((l) => l.tag),
    deals: deals.map((d) => ({ ...d, amount: Number(d.amount) })),
  };
}

export interface UpdateCustomerInput {
  phone?: string;
  name?: string | null;
  email?: string | null;
  sexo?: string | null;
  fechaNacimiento?: string | null;
  idioma?: string | null;
  origenDeLead?: string | null;
  selectedProductId?: string | null;
}

export async function updateCustomer(companyId: string, customerId: string, data: UpdateCustomerInput) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Cliente no encontrado", 404);

  // Validar producto de interés (si viene)
  if (data.selectedProductId) {
    const product = await prisma.product.findFirst({
      where: { id: data.selectedProductId, companyId },
      select: { id: true },
    });
    if (!product) throw new AppError("Producto no encontrado", 404);
  }

  // Corregir el número del chat (a veces el gateway entrega un número mal). Se
  // normaliza a "+<dígitos>" (mismo formato que usa el upsert del inbound, para que
  // futuros mensajes entrantes/salientes calcen) y se evita chocar con otro contacto.
  let phoneUpdate: string | undefined;
  if (data.phone !== undefined) {
    const digits = data.phone.replace(/\D/g, "");
    if (digits.length < 8) throw new AppError("El número debe tener al menos 8 dígitos (con código de país)", 400);
    const normalized = `+${digits}`;
    const clash = await prisma.customer.findFirst({
      where: { companyId, phone: normalized, NOT: { id: customerId } },
      select: { id: true },
    });
    if (clash) throw new AppError("Ya existe otro contacto con ese número en tu cuenta", 409);
    phoneUpdate = normalized;
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      phone: phoneUpdate ?? undefined,
      name: data.name ?? undefined,
      email: data.email ?? undefined,
      sexo: data.sexo ?? undefined,
      fechaNacimiento:
        data.fechaNacimiento === undefined
          ? undefined
          : data.fechaNacimiento
            ? new Date(data.fechaNacimiento)
            : null,
      idioma: data.idioma ?? undefined,
      origenDeLead: data.origenDeLead ?? undefined,
      selectedProductId: data.selectedProductId === undefined ? undefined : data.selectedProductId || null,
    },
  });
  return getCustomer(companyId, customerId);
}

// --- Notas internas por contacto ---

export async function listNotes(companyId: string, customerId: string) {
  return prisma.contactNote.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createNote(
  companyId: string,
  customerId: string,
  data: { text?: string | null; mediaUrl?: string | null; mediaType?: string | null; conversationId?: string | null },
) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } });
  if (!customer) throw new AppError("Cliente no encontrado", 404);
  if (!data.text?.trim() && !data.mediaUrl) {
    throw new AppError("La nota necesita texto o un archivo", 400);
  }
  return prisma.contactNote.create({
    data: {
      companyId,
      customerId,
      conversationId: data.conversationId ?? null,
      text: data.text?.trim() || null,
      mediaUrl: data.mediaUrl ?? null,
      mediaType: data.mediaType ?? null,
    },
  });
}

export async function deleteNote(companyId: string, noteId: string) {
  const existing = await prisma.contactNote.findFirst({ where: { id: noteId, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Nota no encontrada", 404);
  await prisma.contactNote.delete({ where: { id: noteId } });
}

const FLOW_VARS_ALL = null;

/**
 * Quita respuestas del chatbot de flujos de la ficha del cliente
 * (Customer.metadata.flowVars) y de la sesión de flujo guardada en sus
 * conversaciones (Conversation.state.flow.variables — el agente cae a ese
 * fallback si la ficha queda vacía). `keys === null` = todas las visibles
 * (las internas `_…` nunca se tocan). Emite CRM_UPDATED para refrescar tarjetas.
 */
export async function removeCustomerFlowVars(
  companyId: string,
  customerId: string,
  keys: string[] | typeof FLOW_VARS_ALL,
): Promise<{ removed: string[]; remaining: Record<string, string> }> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true, metadata: true },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);

  const md = (customer.metadata && typeof customer.metadata === "object" ? { ...(customer.metadata as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const flowVars = md.flowVars && typeof md.flowVars === "object" ? { ...(md.flowVars as Record<string, unknown>) } : {};
  const visible = Object.keys(flowVars).filter((k) => !k.startsWith("_"));
  const wanted = new Set(keys === null ? visible : keys.map((k) => k.trim()).filter((k) => k && !k.startsWith("_")));
  const removed = visible.filter((k) => wanted.has(k));
  for (const k of removed) delete flowVars[k];

  const remaining: Record<string, string> = {};
  for (const [k, v] of Object.entries(flowVars)) if (!k.startsWith("_") && typeof v === "string") remaining[k] = v;
  if (Object.keys(remaining).length) md.flowVars = flowVars;
  else delete md.flowVars;

  await prisma.customer.update({ where: { id: customerId }, data: { metadata: md as object } });

  // Sesión de flujo en las conversaciones del cliente (fallback del agente).
  const convos = await prisma.conversation.findMany({ where: { customerId, companyId }, select: { id: true, state: true } });
  for (const c of convos) {
    const state = (c.state && typeof c.state === "object" ? (c.state as Record<string, unknown>) : null);
    const flow = state?.flow && typeof state.flow === "object" ? (state.flow as Record<string, unknown>) : null;
    const vars = flow?.variables && typeof flow.variables === "object" ? (flow.variables as Record<string, unknown>) : null;
    if (!vars) continue;
    const hit = Object.keys(vars).filter((k) => wanted.has(k));
    if (!hit.length) continue;
    const nextVars = { ...vars };
    for (const k of hit) delete nextVars[k];
    await prisma.conversation.update({
      where: { id: c.id },
      data: { state: { ...state, flow: { ...flow, variables: nextVars } } as object },
    });
  }

  socketService.emitToCompany(companyId, SOCKET_EVENTS.CRM_UPDATED, { crmId: null });
  return { removed, remaining };
}
