/**
 * Grupos de WhatsApp de un cliente para las listas del panel (Conversaciones y CRM).
 * Archivo aparte, sin dependencias del agente: lo importa conversation.service y
 * así no se forma un ciclo con whatsapp-groups.service.
 */
import type { Prisma, WhatsappGroupMemberStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/** Estados en los que el cliente «está» en el grupo a efectos del panel (invitado = aún no aceptó). */
export const VISIBLE_GROUP_STATUSES: WhatsappGroupMemberStatus[] = ["AGREGADO", "YA_ESTABA", "INVITADO"];

export type CustomerWaGroup = { id: string; name: string; status: WhatsappGroupMemberStatus };

/** Select para traer los grupos visibles de un cliente junto con su fila (listas del panel). */
export const customerWaGroupsSelect = {
  where: { status: { in: VISIBLE_GROUP_STATUSES } },
  orderBy: { createdAt: "asc" as const },
  select: { status: true, group: { select: { id: true, name: true } } },
} satisfies Prisma.Customer$whatsappGroupLinksArgs;

export function toCustomerWaGroups(
  links: Array<{ status: WhatsappGroupMemberStatus; group: { id: string; name: string } }> | undefined,
): CustomerWaGroup[] {
  return (links ?? []).map((l) => ({ id: l.group.id, name: l.group.name, status: l.status }));
}

/** Grupos visibles de varios clientes en UNA consulta (tarjetas del CRM). */
export async function waGroupsByCustomer(companyId: string, customerIds: string[]): Promise<Map<string, CustomerWaGroup[]>> {
  const out = new Map<string, CustomerWaGroup[]>();
  if (!customerIds.length) return out;
  const rows = await prisma.whatsappGroupMember.findMany({
    where: { companyId, customerId: { in: customerIds }, status: { in: VISIBLE_GROUP_STATUSES } },
    orderBy: { createdAt: "asc" },
    select: { customerId: true, status: true, group: { select: { id: true, name: true } } },
  });
  for (const r of rows) {
    const list = out.get(r.customerId) ?? [];
    list.push({ id: r.group.id, name: r.group.name, status: r.status });
    out.set(r.customerId, list);
  }
  return out;
}
