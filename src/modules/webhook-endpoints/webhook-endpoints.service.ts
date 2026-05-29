import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from "./webhook-endpoints.schema";

function generateSecret(): string {
  return "whsec_" + crypto.randomBytes(32).toString("hex");
}

function stripSecret<T extends { secret: string }>(endpoint: T): Omit<T, "secret"> & { secret: undefined } {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { secret: _s, ...rest } = endpoint;
  return { ...rest, secret: undefined } as Omit<T, "secret"> & { secret: undefined };
}

export async function listWebhookEndpoints(companyId: string) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
  });
  return endpoints.map(stripSecret);
}

export async function createWebhookEndpoint(companyId: string, dto: CreateWebhookEndpointDto) {
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      companyId,
      source: dto.source,
      description: dto.description,
      autoApprove: dto.autoApprove ?? true,
      secret: dto.secret,
    },
  });
  // Devuelve el secret en texto plano SOLO en la respuesta de creación
  return { ...endpoint, secret: dto.secret };
}

export async function updateWebhookEndpoint(
  companyId: string,
  id: string,
  dto: UpdateWebhookEndpointDto,
) {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Endpoint no encontrado", 404);

  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data: {
      active: dto.active ?? undefined,
      autoApprove: dto.autoApprove ?? undefined,
      description: dto.description ?? undefined,
    },
  });
  return stripSecret(updated);
}

export async function regenerateSecret(companyId: string, id: string) {
  const existing = await prisma.webhookEndpoint.findFirst({ where: { id, companyId } });
  if (!existing) throw new AppError("Endpoint no encontrado", 404);

  const secret = generateSecret();
  const updated = await prisma.webhookEndpoint.update({
    where: { id },
    data: { secret },
  });
  // Devuelve el secret en texto plano SOLO aquí
  return { ...updated, secret };
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
      status: true,
      error: true,
      receiptId: true,
      receivedAt: true,
    },
  });
}
