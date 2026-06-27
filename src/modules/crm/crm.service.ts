/**
 * CRM kanban multi-tablero.
 *
 * Cada empresa puede tener varios CRMs (tableros); cada CRM tiene columnas y
 * placements (CrmCard) de clientes. El "Inbox" es virtual: clientes con
 * conversación de WhatsApp que aún no fueron movidos a una columna de ese CRM.
 * Incluye etiquetas internas de clientes (CustomerTag) y valores de negocio
 * manuales (CustomerDeal) que suman al monto de la tarjeta junto con los
 * PaymentReceipt aprobados.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

function emitCrmUpdated(companyId: string, crmId?: string) {
  socketService.emitToCompany(companyId, SOCKET_EVENTS.CRM_UPDATED, { crmId: crmId ?? null });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// ---------------------------------------------------------------------------
// CRMs
// ---------------------------------------------------------------------------

const crmSelect = {
  id: true,
  name: true,
  description: true,
  color: true,
  sortOrder: true,
} satisfies Prisma.CrmSelect;

export async function listCrms(companyId: string) {
  return prisma.crm.findMany({
    where: { companyId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: crmSelect,
  });
}

export async function createCrm(
  companyId: string,
  data: { name: string; description?: string | null; color: string },
) {
  try {
    const count = await prisma.crm.count({ where: { companyId } });
    const crm = await prisma.crm.create({
      data: {
        companyId,
        name: data.name,
        description: data.description ?? null,
        color: data.color,
        sortOrder: count,
      },
      select: crmSelect,
    });
    emitCrmUpdated(companyId, crm.id);
    return crm;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("Ya existe un CRM con ese nombre", 409);
    throw err;
  }
}

export async function updateCrm(
  companyId: string,
  id: string,
  data: { name: string; description?: string | null; color: string },
) {
  const existing = await prisma.crm.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("CRM no encontrado", 404);
  try {
    const crm = await prisma.crm.update({
      where: { id },
      data: { name: data.name, description: data.description ?? null, color: data.color },
      select: crmSelect,
    });
    emitCrmUpdated(companyId, id);
    return crm;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("Ya existe un CRM con ese nombre", 409);
    throw err;
  }
}

export async function deleteCrm(companyId: string, id: string) {
  const existing = await prisma.crm.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("CRM no encontrado", 404);
  await prisma.crm.delete({ where: { id } }); // cascade: columnas + cards
  emitCrmUpdated(companyId, id);
}

// ---------------------------------------------------------------------------
// Columnas
// ---------------------------------------------------------------------------

const columnSelect = {
  id: true,
  name: true,
  color: true,
  sortOrder: true,
} satisfies Prisma.CrmColumnSelect;

async function assertCrmOwned(companyId: string, crmId: string) {
  const crm = await prisma.crm.findFirst({ where: { id: crmId, companyId }, select: { id: true } });
  if (!crm) throw new AppError("CRM no encontrado", 404);
}

export async function createColumn(
  companyId: string,
  crmId: string,
  data: { name: string; color?: string | null },
) {
  await assertCrmOwned(companyId, crmId);
  const count = await prisma.crmColumn.count({ where: { crmId } });
  const column = await prisma.crmColumn.create({
    data: { crmId, companyId, name: data.name, color: data.color ?? null, sortOrder: count },
    select: columnSelect,
  });
  emitCrmUpdated(companyId, crmId);
  return column;
}

export async function updateColumn(
  companyId: string,
  crmId: string,
  columnId: string,
  data: { name: string; color?: string | null },
) {
  const existing = await prisma.crmColumn.findFirst({ where: { id: columnId, crmId, companyId } });
  if (!existing) throw new AppError("Columna no encontrada", 404);
  const column = await prisma.crmColumn.update({
    where: { id: columnId },
    data: { name: data.name, color: data.color ?? null },
    select: columnSelect,
  });
  emitCrmUpdated(companyId, crmId);
  return column;
}

export async function deleteColumn(companyId: string, crmId: string, columnId: string) {
  const existing = await prisma.crmColumn.findFirst({ where: { id: columnId, crmId, companyId } });
  if (!existing) throw new AppError("Columna no encontrada", 404);
  // cascade borra los CrmCard => esos clientes vuelven al Inbox
  await prisma.crmColumn.delete({ where: { id: columnId } });
  emitCrmUpdated(companyId, crmId);
}

export async function reorderColumns(companyId: string, crmId: string, columnIds: string[]) {
  await assertCrmOwned(companyId, crmId);
  const owned = await prisma.crmColumn.findMany({
    where: { crmId, id: { in: columnIds } },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((c) => c.id));
  const valid = columnIds.filter((id) => ownedIds.has(id));
  await prisma.$transaction(
    valid.map((id, index) =>
      prisma.crmColumn.update({ where: { id }, data: { sortOrder: index } }),
    ),
  );
  emitCrmUpdated(companyId, crmId);
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface CrmBoardCard {
  customerId: string;
  customer: { id: string; name: string | null; phone: string };
  conversationId: string | null;
  botPaused: boolean;
  lastMessage: {
    message: string | null;
    role: string;
    mediaType: string | null;
    createdAt: Date;
  } | null;
  tags: Array<{ id: string; name: string; color: string }>;
  totalValue: number;
  sortOrder: number | null;
}

export async function getBoard(companyId: string, crmId: string) {
  // 1) CRM + columnas + cards (con su customer)
  const crm = await prisma.crm.findFirst({
    where: { id: crmId, companyId },
    select: {
      ...crmSelect,
      columns: {
        orderBy: { sortOrder: "asc" },
        select: {
          ...columnSelect,
          cards: {
            orderBy: { sortOrder: "asc" },
            select: {
              customerId: true,
              sortOrder: true,
              customer: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      },
    },
  });
  if (!crm) throw new AppError("CRM no encontrado", 404);

  // 2) Conversaciones whatsapp con su último mensaje (misma forma que listConversations)
  const conversations = await prisma.conversation.findMany({
    where: { companyId, channel: "whatsapp" },
    orderBy: { lastMessageAt: "desc" },
    select: {
      id: true,
      customerId: true,
      botPaused: true,
      lastMessageAt: true,
      customer: { select: { id: true, name: true, phone: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { message: true, role: true, mediaType: true, createdAt: true },
      },
    },
  });
  const convoByCustomer = new Map(conversations.map((c) => [c.customerId, c]));

  const placedCustomerIds = new Set(
    crm.columns.flatMap((col) => col.cards.map((card) => card.customerId)),
  );
  const allCustomerIds = [
    ...new Set([...placedCustomerIds, ...conversations.map((c) => c.customerId)]),
  ];

  // 3) Tags por cliente
  const tagLinks = await prisma.customerTagLink.findMany({
    where: { customerId: { in: allCustomerIds }, tag: { companyId } },
    select: { customerId: true, tag: { select: { id: true, name: true, color: true } } },
  });
  const tagsByCustomer = new Map<string, Array<{ id: string; name: string; color: string }>>();
  for (const link of tagLinks) {
    const list = tagsByCustomer.get(link.customerId) ?? [];
    list.push(link.tag);
    tagsByCustomer.set(link.customerId, list);
  }

  // 4) Suma de comprobantes APROBADOS (amounts son String legacy => sumar en JS)
  const receipts = await prisma.paymentReceipt.findMany({
    where: { companyId, status: "APROBADO", customerId: { in: allCustomerIds } },
    select: { customerId: true, amountPaid: true, amountExpected: true },
  });
  const receiptsByCustomer = new Map<string, number>();
  for (const r of receipts) {
    if (!r.customerId) continue;
    const amount = Number(r.amountPaid ?? r.amountExpected);
    if (!Number.isFinite(amount)) continue;
    receiptsByCustomer.set(r.customerId, (receiptsByCustomer.get(r.customerId) ?? 0) + amount);
  }

  // 5) Suma de valores de negocio manuales
  const dealSums = await prisma.customerDeal.groupBy({
    by: ["customerId"],
    where: { companyId, customerId: { in: allCustomerIds } },
    _sum: { amount: true },
  });
  const dealsByCustomer = new Map(
    dealSums.map((d) => [d.customerId, Number(d._sum.amount ?? 0)]),
  );

  function buildCard(
    customer: { id: string; name: string | null; phone: string },
    sortOrder: number | null,
  ): CrmBoardCard {
    const convo = convoByCustomer.get(customer.id) ?? null;
    return {
      customerId: customer.id,
      customer,
      conversationId: convo?.id ?? null,
      botPaused: convo?.botPaused ?? false,
      lastMessage: convo?.messages[0] ?? null,
      tags: tagsByCustomer.get(customer.id) ?? [],
      totalValue:
        (receiptsByCustomer.get(customer.id) ?? 0) + (dealsByCustomer.get(customer.id) ?? 0),
      sortOrder,
    };
  }

  const columns = crm.columns.map((col) => ({
    id: col.id,
    name: col.name,
    color: col.color,
    sortOrder: col.sortOrder,
    cards: col.cards.map((card) => buildCard(card.customer, card.sortOrder)),
  }));

  // Inbox: conversaciones cuyo cliente no está colocado en este CRM (ya vienen
  // ordenadas por lastMessageAt desc)
  const inbox = conversations
    .filter((c) => !placedCustomerIds.has(c.customerId))
    .map((c) => buildCard(c.customer, null));

  return {
    crm: { id: crm.id, name: crm.name, description: crm.description, color: crm.color },
    columns,
    inbox,
  };
}

// ---------------------------------------------------------------------------
// Move (drag & drop)
// ---------------------------------------------------------------------------

export async function moveCard(
  companyId: string,
  crmId: string,
  data: { customerId: string; toColumnId: string | null; position?: number },
) {
  await assertCrmOwned(companyId, crmId);

  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, companyId },
    select: { id: true },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);

  if (data.toColumnId === null) {
    // Volver al Inbox: quitar el placement de este CRM
    await prisma.crmCard.deleteMany({ where: { crmId, customerId: data.customerId } });
    emitCrmUpdated(companyId, crmId);
    return;
  }

  const column = await prisma.crmColumn.findFirst({
    where: { id: data.toColumnId, crmId, companyId },
    select: { id: true },
  });
  if (!column) throw new AppError("Columna no encontrada", 404);

  await prisma.$transaction(async (tx) => {
    // Tarjetas actuales de la columna destino (sin el cliente movido)
    const siblings = await tx.crmCard.findMany({
      where: { columnId: column.id, customerId: { not: data.customerId } },
      orderBy: { sortOrder: "asc" },
      select: { id: true },
    });

    const position = Math.min(data.position ?? siblings.length, siblings.length);

    const moved = await tx.crmCard.upsert({
      where: { crmId_customerId: { crmId, customerId: data.customerId } },
      update: { columnId: column.id, sortOrder: position },
      create: {
        companyId,
        crmId,
        columnId: column.id,
        customerId: data.customerId,
        sortOrder: position,
      },
      select: { id: true },
    });

    // Re-escribir el orden 0..n de la columna destino con el movido insertado.
    // Un solo UPDATE masivo en vez de N (evitaba el timeout de la transacción en
    // columnas con muchos leads). unnest WITH ORDINALITY da el índice 1-based →
    // sortOrder = ord - 1 (denso, 0-based).
    const ordered = [...siblings.slice(0, position), moved, ...siblings.slice(position)];
    const orderedIds = ordered.map((c) => c.id);
    await tx.$executeRaw`
      UPDATE "CrmCard" AS c
      SET "sortOrder" = (v.ord - 1)::int, "updatedAt" = now()
      FROM unnest(${orderedIds}::uuid[]) WITH ORDINALITY AS v(id, ord)
      WHERE c.id = v.id
    `;
  }, { timeout: 15000 });

  emitCrmUpdated(companyId, crmId);
}

/**
 * Acciones reutilizables sobre un cliente: asignarle etiquetas y/o moverlo a una
 * pestaña de un CRM. Best-effort (no lanza): la usan las respuestas rápidas y las
 * acciones de venta por producto. Ignora tags/CRM/columnas que no sean de la empresa.
 */
export async function applyCrmAndTagActions(
  companyId: string,
  customerId: string,
  actions: { tagIds?: string[] | null; crmId?: string | null; crmColumnId?: string | null },
): Promise<void> {
  try {
    if (actions.tagIds?.length) {
      const owned = await prisma.customerTag.findMany({
        where: { companyId, id: { in: actions.tagIds } },
        select: { id: true },
      });
      if (owned.length) {
        await prisma.customerTagLink.createMany({
          data: owned.map((tag) => ({ customerId, tagId: tag.id })),
          skipDuplicates: true,
        });
        emitCrmUpdated(companyId);
      }
    }
    if (actions.crmId && actions.crmColumnId) {
      await moveCard(companyId, actions.crmId, { customerId, toColumnId: actions.crmColumnId });
    }
  } catch (err) {
    console.error("[crm] acciones (tag/mover) fallaron:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Etiquetas internas
// ---------------------------------------------------------------------------

const tagSelect = { id: true, name: true, color: true } satisfies Prisma.CustomerTagSelect;

export async function listTags(companyId: string) {
  return prisma.customerTag.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
    select: tagSelect,
  });
}

export async function createTag(companyId: string, data: { name: string; color: string }) {
  try {
    return await prisma.customerTag.create({
      data: { companyId, name: data.name, color: data.color },
      select: tagSelect,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("La etiqueta ya existe", 409);
    throw err;
  }
}

export async function updateTag(
  companyId: string,
  tagId: string,
  data: { name: string; color: string },
) {
  const existing = await prisma.customerTag.findFirst({ where: { id: tagId, companyId } });
  if (!existing) throw new AppError("Etiqueta no encontrada", 404);
  try {
    return await prisma.customerTag.update({
      where: { id: tagId },
      data: { name: data.name, color: data.color },
      select: tagSelect,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("La etiqueta ya existe", 409);
    throw err;
  }
}

export async function deleteTag(companyId: string, tagId: string) {
  const existing = await prisma.customerTag.findFirst({ where: { id: tagId, companyId } });
  if (!existing) throw new AppError("Etiqueta no encontrada", 404);
  await prisma.customerTag.delete({ where: { id: tagId } }); // cascade borra links
  emitCrmUpdated(companyId);
}

/** Reemplaza el set completo de etiquetas de un cliente. */
export async function setCustomerTags(companyId: string, customerId: string, tagIds: string[]) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);

  const ownedTags = await prisma.customerTag.findMany({
    where: { companyId, id: { in: tagIds } },
    select: { id: true },
  });
  const validIds = ownedTags.map((t) => t.id);

  await prisma.$transaction([
    prisma.customerTagLink.deleteMany({ where: { customerId } }),
    prisma.customerTagLink.createMany({
      data: validIds.map((tagId) => ({ customerId, tagId })),
      skipDuplicates: true,
    }),
  ]);
  emitCrmUpdated(companyId);
}

// ---------------------------------------------------------------------------
// Acciones masivas (selección por pestaña en el kanban)
// ---------------------------------------------------------------------------

/** Filtra una lista de customerIds dejando solo los que pertenecen a la empresa. */
async function ownedCustomerIds(companyId: string, customerIds: string[]): Promise<string[]> {
  const ids = [...new Set(customerIds)];
  const owned = await prisma.customer.findMany({
    where: { companyId, id: { in: ids } },
    select: { id: true },
  });
  return owned.map((c) => c.id);
}

/** Mueve varios leads a una columna del CRM (o al Inbox si toColumnId=null). */
export async function bulkMoveCards(
  companyId: string,
  crmId: string,
  data: { customerIds: string[]; toColumnId: string | null },
): Promise<{ moved: number }> {
  await assertCrmOwned(companyId, crmId);
  if (data.toColumnId !== null) {
    const column = await prisma.crmColumn.findFirst({
      where: { id: data.toColumnId, crmId, companyId },
      select: { id: true },
    });
    if (!column) throw new AppError("Columna no encontrada", 404);
  }
  const ids = await ownedCustomerIds(companyId, data.customerIds);
  for (const customerId of ids) {
    // Reusa moveCard (maneja upsert + renumber + inbox). Append al final de la columna.
    await moveCard(companyId, crmId, { customerId, toColumnId: data.toColumnId });
  }
  emitCrmUpdated(companyId, crmId);
  return { moved: ids.length };
}

/** Asigna y/o quita etiquetas a varios leads (sin reemplazar el set completo). */
export async function bulkTagCards(
  companyId: string,
  data: { customerIds: string[]; addTagIds?: string[]; removeTagIds?: string[] },
): Promise<{ updated: number }> {
  const ids = await ownedCustomerIds(companyId, data.customerIds);
  if (!ids.length) return { updated: 0 };

  const addTagIds = data.addTagIds?.length
    ? (await prisma.customerTag.findMany({
        where: { companyId, id: { in: data.addTagIds } },
        select: { id: true },
      })).map((t) => t.id)
    : [];
  const removeTagIds = data.removeTagIds?.length
    ? (await prisma.customerTag.findMany({
        where: { companyId, id: { in: data.removeTagIds } },
        select: { id: true },
      })).map((t) => t.id)
    : [];

  await prisma.$transaction(async (tx) => {
    if (removeTagIds.length) {
      await tx.customerTagLink.deleteMany({
        where: { customerId: { in: ids }, tagId: { in: removeTagIds } },
      });
    }
    if (addTagIds.length) {
      await tx.customerTagLink.createMany({
        data: ids.flatMap((customerId) => addTagIds.map((tagId) => ({ customerId, tagId }))),
        skipDuplicates: true,
      });
    }
  });
  emitCrmUpdated(companyId);
  return { updated: ids.length };
}

/** Agrega un Valor del negocio (deal) a cada lead seleccionado. */
export async function bulkAddDeals(
  companyId: string,
  data: { customerIds: string[]; amount: number; description?: string },
): Promise<{ created: number }> {
  const ids = await ownedCustomerIds(companyId, data.customerIds);
  if (!ids.length) return { created: 0 };
  const description = data.description?.trim() || "Valor agregado (masivo)";
  await prisma.customerDeal.createMany({
    data: ids.map((customerId) => ({ companyId, customerId, description, amount: data.amount })),
  });
  emitCrmUpdated(companyId);
  return { created: ids.length };
}

// ---------------------------------------------------------------------------
// Valores de negocio (deals manuales)
// ---------------------------------------------------------------------------

const dealSelect = {
  id: true,
  description: true,
  amount: true,
  createdAt: true,
} satisfies Prisma.CustomerDealSelect;

function mapDeal(deal: { id: string; description: string; amount: Prisma.Decimal; createdAt: Date }) {
  return { ...deal, amount: Number(deal.amount) };
}

export async function listDeals(companyId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);
  const deals = await prisma.customerDeal.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "desc" },
    select: dealSelect,
  });
  return deals.map(mapDeal);
}

export async function createDeal(
  companyId: string,
  customerId: string,
  data: { description: string; amount: number },
) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);
  const deal = await prisma.customerDeal.create({
    data: { companyId, customerId, description: data.description, amount: data.amount },
    select: dealSelect,
  });
  emitCrmUpdated(companyId);
  return mapDeal(deal);
}

export async function updateDeal(
  companyId: string,
  dealId: string,
  data: { description: string; amount: number },
) {
  const existing = await prisma.customerDeal.findFirst({ where: { id: dealId, companyId } });
  if (!existing) throw new AppError("Valor no encontrado", 404);
  const deal = await prisma.customerDeal.update({
    where: { id: dealId },
    data: { description: data.description, amount: data.amount },
    select: dealSelect,
  });
  emitCrmUpdated(companyId);
  return mapDeal(deal);
}

export async function deleteDeal(companyId: string, dealId: string) {
  const existing = await prisma.customerDeal.findFirst({ where: { id: dealId, companyId } });
  if (!existing) throw new AppError("Valor no encontrado", 404);
  await prisma.customerDeal.delete({ where: { id: dealId } });
  emitCrmUpdated(companyId);
}

// ---------------------------------------------------------------------------
// Embudo de ventas
// ---------------------------------------------------------------------------

/**
 * Suma de valor (comprobantes APROBADO + valores de negocio manuales) por
 * cliente para un conjunto dado. Reusa la lógica de la tarjeta del board.
 */
async function valueByCustomers(
  companyId: string,
  customerIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!customerIds.length) return result;

  const receipts = await prisma.paymentReceipt.findMany({
    where: { companyId, status: "APROBADO", customerId: { in: customerIds } },
    select: { customerId: true, amountPaid: true, amountExpected: true },
  });
  for (const r of receipts) {
    if (!r.customerId) continue;
    const amount = Number(r.amountPaid ?? r.amountExpected);
    if (!Number.isFinite(amount)) continue;
    result.set(r.customerId, (result.get(r.customerId) ?? 0) + amount);
  }

  const dealSums = await prisma.customerDeal.groupBy({
    by: ["customerId"],
    where: { companyId, customerId: { in: customerIds } },
    _sum: { amount: true },
  });
  for (const d of dealSums) {
    result.set(d.customerId, (result.get(d.customerId) ?? 0) + Number(d._sum.amount ?? 0));
  }

  return result;
}

export type FunnelMode = "crm" | "columns" | "tags";

export interface FunnelLevel {
  key: string;
  label: string;
  color: string | null;
  count: number;
  value: number;
}

export interface FunnelResult {
  mode: FunnelMode;
  crmId: string | null;
  totalContacts: number;
  totalValue: number;
  levels: FunnelLevel[];
}

/**
 * Métricas del embudo de ventas. Tres modos de agrupación:
 *  - crm: un nivel por tablero CRM (clientes con tarjeta + valor).
 *  - columns: un nivel por columna de un CRM (requiere crmId).
 *  - tags: un nivel por etiqueta (clientes con esa etiqueta + valor).
 */
export async function getFunnelMetrics(
  companyId: string,
  mode: FunnelMode,
  crmId?: string | null,
): Promise<FunnelResult> {
  const totalContacts = await prisma.customer.count({ where: { companyId } });

  let levels: FunnelLevel[] = [];

  if (mode === "tags") {
    const tags = await prisma.customerTag.findMany({
      where: { companyId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    });
    const links = await prisma.customerTagLink.findMany({
      where: { tag: { companyId } },
      select: { customerId: true, tagId: true },
    });
    const customersByTag = new Map<string, string[]>();
    for (const l of links) {
      const arr = customersByTag.get(l.tagId) ?? [];
      arr.push(l.customerId);
      customersByTag.set(l.tagId, arr);
    }
    const valueMap = await valueByCustomers(companyId, [...new Set(links.map((l) => l.customerId))]);
    levels = tags.map((t) => {
      const ids = customersByTag.get(t.id) ?? [];
      return {
        key: t.id,
        label: t.name,
        color: t.color,
        count: ids.length,
        value: ids.reduce((s, id) => s + (valueMap.get(id) ?? 0), 0),
      };
    });
  } else if (mode === "columns") {
    if (!crmId) throw new AppError("crmId requerido para el modo columns", 400);
    await assertCrmOwned(companyId, crmId);
    const columns = await prisma.crmColumn.findMany({
      where: { crmId, companyId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, color: true, cards: { select: { customerId: true } } },
    });
    const allIds = [...new Set(columns.flatMap((c) => c.cards.map((card) => card.customerId)))];
    const valueMap = await valueByCustomers(companyId, allIds);
    levels = columns.map((col) => {
      const ids = col.cards.map((c) => c.customerId);
      return {
        key: col.id,
        label: col.name,
        color: col.color,
        count: ids.length,
        value: ids.reduce((s, id) => s + (valueMap.get(id) ?? 0), 0),
      };
    });
  } else {
    // mode === "crm": un nivel por tablero
    const crms = await prisma.crm.findMany({
      where: { companyId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, color: true, cards: { select: { customerId: true } } },
    });
    const allIds = [...new Set(crms.flatMap((c) => c.cards.map((card) => card.customerId)))];
    const valueMap = await valueByCustomers(companyId, allIds);
    levels = crms.map((crm) => {
      const ids = [...new Set(crm.cards.map((c) => c.customerId))];
      return {
        key: crm.id,
        label: crm.name,
        color: crm.color,
        count: ids.length,
        value: ids.reduce((s, id) => s + (valueMap.get(id) ?? 0), 0),
      };
    });
  }

  const totalValue = levels.reduce((s, l) => s + l.value, 0);
  return { mode, crmId: crmId ?? null, totalContacts, totalValue, levels };
}
