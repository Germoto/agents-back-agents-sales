import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { decryptCredential, encryptCredential } from "../../lib/credentials-crypto";
import type { FlatVars } from "../../lib/http-template";
import type { CreateActionDto, CreateConnectionDto, HttpRequestDto, UpdateActionDto, UpdateConnectionDto } from "./http-actions.schemas";
import { runHttpAction, toRunnableConnection, toRunnableRequest, type HttpRunSource } from "./http-action-runner";

// ---------------------------------------------------------------------------
// Conexiones
// ---------------------------------------------------------------------------

function maskSecret(stored: string | null): string | null {
  if (!stored) return null;
  const plain = decryptCredential(stored);
  return plain ? `•••${plain.slice(-4)}` : null;
}

const connectionSelect = {
  id: true,
  name: true,
  baseUrl: true,
  authType: true,
  authName: true,
  authSecret: true,
  headers: true,
  timeoutMs: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { actions: true } },
} satisfies Prisma.HttpConnectionSelect;

function serializeConnection(row: Prisma.HttpConnectionGetPayload<{ select: typeof connectionSelect }>) {
  const { authSecret, _count, ...rest } = row;
  return { ...rest, authSecretSet: !!authSecret, authSecretMasked: maskSecret(authSecret), actionsCount: _count.actions };
}

export async function listConnections(companyId: string) {
  const rows = await prisma.httpConnection.findMany({ where: { companyId }, orderBy: { createdAt: "asc" }, select: connectionSelect });
  return rows.map(serializeConnection);
}

export async function createConnection(companyId: string, dto: CreateConnectionDto) {
  const row = await prisma.httpConnection.create({
    data: {
      companyId,
      name: dto.name,
      baseUrl: dto.baseUrl ?? "",
      authType: dto.authType,
      authName: dto.authName?.trim() || null,
      authSecret: dto.authSecret?.trim() ? encryptCredential(dto.authSecret.trim()) : null,
      headers: dto.headers ?? {},
      timeoutMs: dto.timeoutMs ?? 15000,
    },
    select: connectionSelect,
  });
  return serializeConnection(row);
}

export async function updateConnection(companyId: string, id: string, dto: UpdateConnectionDto) {
  const existing = await prisma.httpConnection.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Conexión no encontrada", 404);
  const data: Prisma.HttpConnectionUpdateInput = {};
  if (dto.name !== undefined) data.name = dto.name;
  if (dto.baseUrl !== undefined) data.baseUrl = dto.baseUrl ?? "";
  if (dto.authType !== undefined) data.authType = dto.authType;
  if (dto.authName !== undefined) data.authName = dto.authName?.trim() || null;
  if (dto.headers !== undefined) data.headers = dto.headers ?? {};
  if (dto.timeoutMs !== undefined) data.timeoutMs = dto.timeoutMs;
  // Secreto: undefined / "" = no tocar; null = borrar; texto = reemplazar (cifrado).
  if (dto.authSecret === null) data.authSecret = null;
  else if (typeof dto.authSecret === "string" && dto.authSecret.trim()) data.authSecret = encryptCredential(dto.authSecret.trim());
  const row = await prisma.httpConnection.update({ where: { id }, data, select: connectionSelect });
  return serializeConnection(row);
}

export async function deleteConnection(companyId: string, id: string) {
  const existing = await prisma.httpConnection.findFirst({
    where: { id, companyId },
    select: { id: true, actions: { select: { id: true, name: true } } },
  });
  if (!existing) throw new AppError("Conexión no encontrada", 404);
  if (existing.actions.length) {
    throw new AppError(
      `Esta conexión la usan ${existing.actions.length} acción(es): ${existing.actions.map((a) => a.name).join(", ")}. Cámbialas de conexión antes de borrarla.`,
      409,
    );
  }
  await prisma.httpConnection.delete({ where: { id } });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

const actionSelect = {
  id: true,
  connectionId: true,
  name: true,
  description: true,
  method: true,
  url: true,
  query: true,
  headers: true,
  bodyType: true,
  body: true,
  responseVar: true,
  retries: true,
  agentEnabled: true,
  agentDescription: true,
  agentParams: true,
  oncePerCustomer: true,
  agentResultHint: true,
  lastRunAt: true,
  lastRunOk: true,
  lastResponseKeys: true,
  createdAt: true,
  updatedAt: true,
  connection: { select: { id: true, name: true, baseUrl: true, authType: true } },
} satisfies Prisma.HttpActionSelect;

export type HttpActionView = Prisma.HttpActionGetPayload<{ select: typeof actionSelect }> & { toolName: string | null };

/** Nombre de la tool dinámica del agente: accion_<slug> (≤ 40 chars). */
export function actionToolName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return `accion_${slug || "sin_nombre"}`;
}

function withToolName<T extends { name: string; agentEnabled: boolean }>(row: T): T & { toolName: string | null } {
  return { ...row, toolName: row.agentEnabled ? actionToolName(row.name) : null };
}

async function assertConnection(companyId: string, connectionId: string | null | undefined) {
  if (!connectionId) return;
  const c = await prisma.httpConnection.findFirst({ where: { id: connectionId, companyId }, select: { id: true } });
  if (!c) throw new AppError("La conexión elegida no existe", 404);
}

export async function listActions(companyId: string): Promise<HttpActionView[]> {
  const rows = await prisma.httpAction.findMany({ where: { companyId }, orderBy: { createdAt: "asc" }, select: actionSelect });
  return rows.map(withToolName);
}

export async function getAction(companyId: string, id: string): Promise<HttpActionView> {
  const row = await prisma.httpAction.findFirst({ where: { id, companyId }, select: actionSelect });
  if (!row) throw new AppError("Acción no encontrada", 404);
  return withToolName(row);
}

async function assertUniqueToolName(companyId: string, name: string, agentEnabled: boolean, exceptId?: string) {
  if (!agentEnabled) return;
  const tool = actionToolName(name);
  const others = await prisma.httpAction.findMany({
    where: { companyId, agentEnabled: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true },
  });
  if (others.some((o) => actionToolName(o.name) === tool)) {
    throw new AppError(`Ya hay otra acción del agente con el mismo nombre de herramienta (${tool}). Cambia el nombre.`, 409);
  }
}

export async function createAction(companyId: string, dto: CreateActionDto): Promise<HttpActionView> {
  await assertConnection(companyId, dto.connectionId);
  await assertUniqueToolName(companyId, dto.name, dto.agentEnabled ?? false);
  const row = await prisma.httpAction.create({
    data: {
      companyId,
      connectionId: dto.connectionId ?? null,
      name: dto.name,
      description: dto.description?.trim() || null,
      method: dto.method,
      url: dto.url,
      query: dto.query ?? [],
      headers: dto.headers ?? [],
      bodyType: dto.bodyType,
      body: dto.body ?? null,
      responseVar: dto.responseVar ?? "api",
      retries: dto.retries ?? 1,
      agentEnabled: dto.agentEnabled ?? false,
      agentDescription: dto.agentDescription?.trim() || null,
      agentParams: dto.agentParams ?? [],
      oncePerCustomer: dto.oncePerCustomer ?? false,
      agentResultHint: dto.agentResultHint?.trim() || null,
    },
    select: actionSelect,
  });
  return withToolName(row);
}

export async function updateAction(companyId: string, id: string, dto: UpdateActionDto): Promise<HttpActionView> {
  const existing = await prisma.httpAction.findFirst({ where: { id, companyId }, select: { id: true, name: true, agentEnabled: true } });
  if (!existing) throw new AppError("Acción no encontrada", 404);
  if (dto.connectionId !== undefined) await assertConnection(companyId, dto.connectionId);
  await assertUniqueToolName(companyId, dto.name ?? existing.name, dto.agentEnabled ?? existing.agentEnabled, id);
  const data: Prisma.HttpActionUpdateInput = {};
  if (dto.connectionId !== undefined) data.connection = dto.connectionId ? { connect: { id: dto.connectionId } } : { disconnect: true };
  if (dto.name !== undefined) data.name = dto.name;
  if (dto.description !== undefined) data.description = dto.description?.trim() || null;
  if (dto.method !== undefined) data.method = dto.method;
  if (dto.url !== undefined) data.url = dto.url;
  if (dto.query !== undefined) data.query = dto.query ?? [];
  if (dto.headers !== undefined) data.headers = dto.headers ?? [];
  if (dto.bodyType !== undefined) data.bodyType = dto.bodyType;
  if (dto.body !== undefined) data.body = dto.body ?? null;
  if (dto.responseVar !== undefined) data.responseVar = dto.responseVar ?? "api";
  if (dto.retries !== undefined) data.retries = dto.retries ?? 1;
  if (dto.agentEnabled !== undefined) data.agentEnabled = dto.agentEnabled;
  if (dto.agentDescription !== undefined) data.agentDescription = dto.agentDescription?.trim() || null;
  if (dto.agentParams !== undefined) data.agentParams = dto.agentParams ?? [];
  if (dto.oncePerCustomer !== undefined) data.oncePerCustomer = dto.oncePerCustomer;
  if (dto.agentResultHint !== undefined) data.agentResultHint = dto.agentResultHint?.trim() || null;
  const row = await prisma.httpAction.update({ where: { id }, data, select: actionSelect });
  return withToolName(row);
}

export async function deleteAction(companyId: string, id: string) {
  const existing = await prisma.httpAction.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Acción no encontrada", 404);
  await prisma.httpAction.delete({ where: { id } });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Ejecución (compartida por panel, flujos, entrega y agente)
// ---------------------------------------------------------------------------

/** Carga acción + conexión del tenant listas para ejecutar. */
export async function loadRunnableAction(companyId: string, actionId: string) {
  const row = await prisma.httpAction.findFirst({ where: { id: actionId, companyId }, include: { connection: true } });
  if (!row) return null;
  return { row, request: toRunnableRequest(row), connection: toRunnableConnection(row.connection) };
}

/** Variables base del negocio/cliente para cualquier petición. */
export function baseVars(input: {
  companyName?: string | null;
  customer?: { id?: string | null; name?: string | null; phone?: string | null; email?: string | null } | null;
  conversationId?: string | null;
  product?: { id?: string | null; name?: string | null; price?: string | number | null } | null;
  receiptId?: string | null;
}): FlatVars {
  const now = new Date();
  return {
    empresa: input.companyName ?? "",
    nombre: input.customer?.name ?? "",
    telefono: input.customer?.phone ?? "",
    correo: input.customer?.email ?? "",
    cliente_id: input.customer?.id ?? "",
    conversacion_id: input.conversationId ?? "",
    producto: input.product?.name ?? "",
    producto_id: input.product?.id ?? "",
    precio: input.product?.price != null ? String(input.product.price) : "",
    pedido: input.receiptId ?? "",
    fecha: now.toISOString(),
    ahora_unix: String(Math.floor(now.getTime() / 1000)),
  };
}

/** Variables de prueba (contacto ficticio) para el botón Probar. */
export async function testVars(companyId: string, overrides: FlatVars = {}): Promise<FlatVars> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
  return {
    ...baseVars({
      companyName: company?.name ?? "",
      customer: { id: "00000000-0000-0000-0000-000000000000", name: "Ana Torres", phone: "51999999999", email: "ana@ejemplo.com" },
      conversationId: "prueba",
      product: { id: "", name: "Producto de prueba", price: "0" },
      receiptId: "prueba",
    }),
    ...overrides,
  };
}

export interface ExecuteActionInput {
  companyId: string;
  actionId: string;
  vars: FlatVars;
  source: HttpRunSource;
  refs?: { customerId?: string | null; conversationId?: string | null; receiptId?: string | null; productId?: string | null };
  idempotencyKey?: string | null;
}

/** Ejecuta una acción guardada del tenant. Lanza 404 si no existe. */
export async function executeAction(input: ExecuteActionInput) {
  const loaded = await loadRunnableAction(input.companyId, input.actionId);
  if (!loaded) throw new AppError("Acción HTTP no encontrada", 404);
  const result = await runHttpAction({
    companyId: input.companyId,
    actionId: loaded.row.id,
    request: loaded.request,
    connection: loaded.connection,
    vars: input.vars,
    source: input.source,
    refs: input.refs,
    idempotencyKey: input.idempotencyKey ?? null,
  });
  return { action: loaded.row, result };
}

export async function testAction(companyId: string, actionId: string, overrides: FlatVars) {
  const vars = await testVars(companyId, overrides);
  const { result } = await executeAction({ companyId, actionId, vars, source: "TEST" });
  return { ...result, variablesEntrada: vars };
}

export async function testInline(companyId: string, request: HttpRequestDto, overrides: FlatVars) {
  const vars = await testVars(companyId, overrides);
  let connection = null;
  if (request.connectionId) {
    const c = await prisma.httpConnection.findFirst({ where: { id: request.connectionId, companyId } });
    if (!c) throw new AppError("La conexión elegida no existe", 404);
    connection = toRunnableConnection(c);
  }
  const result = await runHttpAction({
    companyId,
    actionId: null,
    request: toRunnableRequest({ ...request, body: request.body ?? null }),
    connection,
    vars,
    source: "TEST",
  });
  return { ...result, variablesEntrada: vars };
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------

export async function listRuns(companyId: string, opts: { actionId?: string; page: number; limit: number }) {
  const take = Math.min(Math.max(opts.limit, 1), 100);
  const skip = Math.max(opts.page - 1, 0) * take;
  const rows = await prisma.httpActionRun.findMany({
    where: { companyId, ...(opts.actionId ? { actionId: opts.actionId } : {}) },
    orderBy: { createdAt: "desc" },
    skip,
    take: take + 1,
    select: {
      id: true,
      actionId: true,
      source: true,
      customerId: true,
      conversationId: true,
      receiptId: true,
      productId: true,
      status: true,
      httpStatus: true,
      durationMs: true,
      request: true,
      response: true,
      error: true,
      createdAt: true,
      action: { select: { name: true } },
    },
  });
  const hasMore = rows.length > take;
  const items = (hasMore ? rows.slice(0, take) : rows).map((r) => ({ ...r, actionName: r.action?.name ?? null, action: undefined }));
  return { items, hasMore };
}

/** Acciones expuestas al agente IA de un tenant (para buildBotConfig). */
export async function listAgentActions(companyId: string) {
  const rows = await prisma.httpAction.findMany({
    where: { companyId, agentEnabled: true },
    select: { id: true, name: true, description: true, agentDescription: true, agentParams: true, oncePerCustomer: true, agentResultHint: true, responseVar: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    toolName: actionToolName(r.name),
    description: r.agentDescription?.trim() || r.description?.trim() || `Ejecuta la acción ${r.name}`,
    params: (Array.isArray(r.agentParams) ? r.agentParams : []) as { name: string; description?: string; required?: boolean }[],
    oncePerCustomer: r.oncePerCustomer,
    resultHint: r.agentResultHint?.trim() || null,
    responseVar: r.responseVar || "api",
  }));
}
