import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from "./webhook-endpoints.schema";

function generateSecret(): string {
  return "whsec_" + crypto.randomBytes(32).toString("hex");
}

function stripSecret<T extends { secret: string; validpayApiKey?: string | null }>(
  endpoint: T,
): Omit<T, "secret" | "validpayApiKey"> & { secret: undefined; hasValidpayApiKey: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret: _s, validpayApiKey, ...rest } = endpoint;
  return {
    ...rest,
    secret: undefined,
    hasValidpayApiKey: !!validpayApiKey,
  } as Omit<T, "secret" | "validpayApiKey"> & { secret: undefined; hasValidpayApiKey: boolean };
}

export async function listWebhookEndpoints(companyId: string) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
  });
  return endpoints.map(stripSecret);
}

export async function createWebhookEndpoint(companyId: string, dto: CreateWebhookEndpointDto) {
  console.log("[webhook-endpoints] createWebhookEndpoint dto:", JSON.stringify({
    source: dto.source,
    hasSecret: !!dto.secret,
    hasValidpayApiKey: !!dto.validpayApiKey,
    validpayApiKeyLen: dto.validpayApiKey?.length ?? 0,
  }));
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      companyId,
      source: dto.source,
      description: dto.description,
      autoApprove: dto.autoApprove ?? true,
      secret: dto.secret,
      validpayApiKey: dto.validpayApiKey ?? null,
    },
  });
  // Devuelve el secret en texto plano SOLO en la respuesta de creación
  return { ...endpoint, secret: dto.secret, hasValidpayApiKey: !!endpoint.validpayApiKey };
}

export async function updateWebhookEndpoint(
  companyId: string,
  id: string,
  dto: UpdateWebhookEndpointDto,
) {
  console.log("[webhook-endpoints] updateWebhookEndpoint dto:", JSON.stringify({
    ...dto,
    validpayApiKey: dto.validpayApiKey ? `[SET:${String(dto.validpayApiKey).length}chars]` : dto.validpayApiKey,
  }));
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Endpoint no encontrado", 404);

  // Construir el objeto de actualización explícitamente
  // para no depender de la distinción undefined vs ausente de Zod v4
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataToUpdate: Record<string, any> = {};
  if (dto.active !== undefined) dataToUpdate.active = dto.active;
  if (dto.autoApprove !== undefined) dataToUpdate.autoApprove = dto.autoApprove;
  if (dto.description !== undefined) dataToUpdate.description = dto.description;
  // validpayApiKey: null → borrar, string → actualizar, undefined (no vino en body) → no tocar
  if ("validpayApiKey" in (dto as object) && dto.validpayApiKey !== undefined) {
    dataToUpdate.validpayApiKey = dto.validpayApiKey; // puede ser null o string
  }

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data: dataToUpdate,
  });
  return stripSecret(updated);
}

export async function regenerateSecret(companyId: string, id: string, newSecret: string) {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Endpoint no encontrado", 404);

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data: { secret: newSecret },
  });
  return stripSecret(updated);
}

export async function deleteWebhookEndpoint(companyId: string, id: string) {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Endpoint no encontrado", 404);
  await prisma.webhookEndpoint.delete({ where: { id } });
  return { ok: true };
}

export async function listEndpointEvents(companyId: string, endpointId: string, limit = 50) {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, companyId } });
  if (!existing) throw new AppError("Endpoint no encontrado", 404);

  return prisma.webhookEvent.findMany({
    where: { endpointId },
    orderBy: { receivedAt: "desc" },
    take: Math.min(limit, 100),
    select: {
      id: true,
      source: true,
      externalId: true,
      eventType: true,
      status: true,
      error: true,
      receiptId: true,
      receivedAt: true,
    },
  });
}
