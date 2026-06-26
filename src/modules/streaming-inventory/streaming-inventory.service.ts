/**
 * Inventario de credenciales/cuentas de streaming (rubro STREAMER).
 * Cada fila es una unidad vendible (un perfil o una cuenta completa) que abastece
 * a un producto/plan. El agente, en modo POOL_AUTO, toma (claim atómico) una
 * credencial AVAILABLE al aprobarse el pago y la marca ASSIGNED.
 */

import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import type { Prisma } from "@prisma/client";

export interface CredentialInput {
  optionLabel?: string | null;
  email?: string | null;
  username?: string | null;
  password?: string | null;
  profileName?: string | null;
  pin?: string | null;
  extra?: string | null;
  note?: string | null;
}

async function ensureProductBelongs(companyId: string, productId: string) {
  const p = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!p) throw new AppError("Producto no encontrado", 404);
}

export async function listCredentials(companyId: string, productId?: string) {
  return prisma.streamingCredential.findMany({
    where: { companyId, ...(productId ? { productId } : {}) },
    orderBy: [{ productId: "asc" }, { status: "asc" }, { createdAt: "asc" }],
  });
}

/** Resumen por producto: disponibles / asignadas / total. Para badges en el panel. */
export async function credentialStats(companyId: string) {
  const rows = await prisma.streamingCredential.groupBy({
    by: ["productId", "status"],
    where: { companyId },
    _count: { _all: true },
  });
  const byProduct: Record<string, { available: number; assigned: number; down: number; disabled: number; total: number }> = {};
  for (const r of rows) {
    const e = (byProduct[r.productId] ??= { available: 0, assigned: 0, down: 0, disabled: 0, total: 0 });
    const n = r._count._all;
    e.total += n;
    if (r.status === "AVAILABLE") e.available += n;
    else if (r.status === "ASSIGNED") e.assigned += n;
    else if (r.status === "DOWN") e.down += n;
    else if (r.status === "DISABLED") e.disabled += n;
  }
  return byProduct;
}

/** Alta en lote de credenciales para un producto. */
export async function createCredentials(companyId: string, productId: string, items: CredentialInput[]) {
  await ensureProductBelongs(companyId, productId);
  const clean = items
    .map((it) => ({
      companyId,
      productId,
      optionLabel: it.optionLabel?.trim() || null,
      email: it.email?.trim() || null,
      username: it.username?.trim() || null,
      password: it.password?.trim() || null,
      profileName: it.profileName?.trim() || null,
      pin: it.pin?.trim() || null,
      extra: it.extra?.trim() || null,
      note: it.note?.trim() || null,
    }))
    // Al menos un dato de acceso para que la credencial sea útil.
    .filter((it) => it.email || it.username || it.password || it.profileName || it.extra);
  if (!clean.length) throw new AppError("No hay credenciales válidas para agregar", 400);
  await prisma.streamingCredential.createMany({ data: clean });
  return { created: clean.length };
}

export async function updateCredential(companyId: string, id: string, data: CredentialInput & { status?: string }) {
  const cred = await prisma.streamingCredential.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!cred) throw new AppError("Credencial no encontrada", 404);
  const patch: Prisma.StreamingCredentialUpdateInput = {};
  const fields: (keyof CredentialInput)[] = ["optionLabel", "email", "username", "password", "profileName", "pin", "extra", "note"];
  for (const f of fields) {
    if (f in data) (patch as Record<string, unknown>)[f] = (data[f] as string | null)?.toString().trim() || null;
  }
  if (data.status && ["AVAILABLE", "ASSIGNED", "DOWN", "DISABLED"].includes(data.status)) {
    (patch as Record<string, unknown>).status = data.status;
  }
  return prisma.streamingCredential.update({ where: { id }, data: patch });
}

export async function deleteCredential(companyId: string, id: string) {
  const cred = await prisma.streamingCredential.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!cred) throw new AppError("Credencial no encontrada", 404);
  await prisma.streamingCredential.delete({ where: { id } });
  return { ok: true };
}

/** Cuenta de credenciales AVAILABLE para un producto (y su plan, si aplica). */
export async function countAvailable(companyId: string, productId: string, optionLabel?: string | null): Promise<number> {
  if (optionLabel) {
    return prisma.streamingCredential.count({
      where: { companyId, productId, status: "AVAILABLE", OR: [{ optionLabel }, { optionLabel: null }] },
    });
  }
  return prisma.streamingCredential.count({ where: { companyId, productId, status: "AVAILABLE" } });
}

/**
 * Reclama (atómico) una credencial AVAILABLE para entregar. Prefiere una con el
 * optionLabel del plan comprado; si no hay, usa una genérica (optionLabel null).
 * Devuelve la credencial asignada o null si no hay stock. No lanza.
 */
export async function claimAvailableCredential(
  companyId: string,
  productId: string,
  optionLabel: string | null | undefined,
  assign: { customerId: string; conversationId?: string | null; expiresAt?: Date | null },
) {
  return prisma.$transaction(async (tx) => {
    const pick = async (where: Prisma.StreamingCredentialWhereInput) =>
      tx.streamingCredential.findFirst({ where, orderBy: { createdAt: "asc" }, select: { id: true } });

    let cand = optionLabel
      ? (await pick({ companyId, productId, status: "AVAILABLE", optionLabel })) ??
        (await pick({ companyId, productId, status: "AVAILABLE", optionLabel: null }))
      : await pick({ companyId, productId, status: "AVAILABLE" });

    if (!cand) return null;

    // Claim atómico: solo gana si seguía AVAILABLE (evita doble venta del mismo cupo).
    const res = await tx.streamingCredential.updateMany({
      where: { id: cand.id, status: "AVAILABLE" },
      data: {
        status: "ASSIGNED",
        assignedCustomerId: assign.customerId,
        assignedConversationId: assign.conversationId ?? null,
        assignedAt: new Date(),
        expiresAt: assign.expiresAt ?? null,
      },
    });
    if (res.count !== 1) return null;
    return tx.streamingCredential.findUnique({ where: { id: cand.id } });
  });
}
