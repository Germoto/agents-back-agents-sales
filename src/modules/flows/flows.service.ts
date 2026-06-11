/**
 * CRUD de flujos guiados de chatbot (ChatFlow). El motor de ejecución vive en
 * flow-engine.ts; aquí solo gestión + validación al activar.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { validateFlow, type ValidationResult } from "./flow-validation";
import { DEFAULT_TRIGGER, type FlowNode, type FlowEdge, type FlowTrigger, type FlowControlData } from "./flow-types";

const flowSelect = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  trigger: true,
  nodes: true,
  edges: true,
  viewport: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ChatFlowSelect;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function nodesOf(flow: { nodes: unknown }): FlowNode[] {
  return (flow.nodes as unknown as FlowNode[]) ?? [];
}

function edgesOf(flow: { edges: unknown }): FlowEdge[] {
  return (flow.edges as unknown as FlowEdge[]) ?? [];
}

async function knownFlowIds(companyId: string): Promise<string[]> {
  const rows = await prisma.chatFlow.findMany({ where: { companyId }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function listFlows(companyId: string) {
  const flows = await prisma.chatFlow.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, description: true, isActive: true, trigger: true, nodes: true, createdAt: true, updatedAt: true },
  });
  return flows.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    isActive: f.isActive,
    trigger: f.trigger,
    nodeCount: Math.max(0, nodesOf(f).length - 1), // sin contar el Inicio
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }));
}

export async function getFlow(companyId: string, id: string) {
  const flow = await prisma.chatFlow.findFirst({ where: { id, companyId }, select: flowSelect });
  if (!flow) throw new AppError("Flujo no encontrado", 404);
  return flow;
}

export async function createFlow(companyId: string, data: { name: string; description?: string }) {
  try {
    return await prisma.chatFlow.create({
      data: {
        companyId,
        name: data.name,
        description: data.description ?? "",
        trigger: DEFAULT_TRIGGER as unknown as Prisma.InputJsonValue,
        nodes: [
          { id: "start", type: "start", position: { x: 80, y: 240 }, data: {} },
        ] as unknown as Prisma.InputJsonValue,
        edges: [] as unknown as Prisma.InputJsonValue,
      },
      select: flowSelect,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("Ya existe un flujo con ese nombre", 409);
    throw err;
  }
}

export async function updateFlow(
  companyId: string,
  id: string,
  data: {
    name?: string;
    description?: string;
    trigger?: FlowTrigger;
    nodes?: FlowNode[];
    edges?: FlowEdge[];
    viewport?: { x: number; y: number; zoom: number } | null;
  },
) {
  const existing = await prisma.chatFlow.findFirst({ where: { id, companyId }, select: { id: true, isActive: true } });
  if (!existing) throw new AppError("Flujo no encontrado", 404);

  try {
    let flow = await prisma.chatFlow.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.trigger !== undefined ? { trigger: data.trigger as unknown as Prisma.InputJsonValue } : {}),
        ...(data.nodes !== undefined ? { nodes: data.nodes as unknown as Prisma.InputJsonValue } : {}),
        ...(data.edges !== undefined ? { edges: data.edges as unknown as Prisma.InputJsonValue } : {}),
        ...(data.viewport !== undefined
          ? { viewport: data.viewport === null ? Prisma.JsonNull : (data.viewport as unknown as Prisma.InputJsonValue) }
          : {}),
      },
      select: flowSelect,
    });

    // Si el flujo estaba activo y la edición lo dejó inválido → auto-desactivar.
    let deactivated = false;
    let validation: ValidationResult | null = null;
    if (existing.isActive && (data.nodes !== undefined || data.edges !== undefined)) {
      validation = validateFlow(nodesOf(flow), edgesOf(flow), { knownFlowIds: await knownFlowIds(companyId) });
      if (validation.errors.length) {
        flow = await prisma.chatFlow.update({ where: { id }, data: { isActive: false }, select: flowSelect });
        deactivated = true;
      }
    }

    return { flow, deactivated, errors: deactivated ? validation?.errors ?? [] : [] };
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("Ya existe un flujo con ese nombre", 409);
    throw err;
  }
}

export async function duplicateFlow(companyId: string, id: string) {
  const source = await prisma.chatFlow.findFirst({ where: { id, companyId }, select: flowSelect });
  if (!source) throw new AppError("Flujo no encontrado", 404);

  // Nombre único: "X (copia)", "X (copia 2)", ...
  let name = `${source.name} (copia)`;
  for (let i = 2; i <= 20; i++) {
    const exists = await prisma.chatFlow.findFirst({ where: { companyId, name }, select: { id: true } });
    if (!exists) break;
    name = `${source.name} (copia ${i})`;
  }

  return prisma.chatFlow.create({
    data: {
      companyId,
      name,
      description: source.description,
      isActive: false,
      trigger: source.trigger as Prisma.InputJsonValue,
      nodes: source.nodes as Prisma.InputJsonValue,
      edges: source.edges as Prisma.InputJsonValue,
      viewport: source.viewport === null ? Prisma.JsonNull : (source.viewport as Prisma.InputJsonValue),
    },
    select: flowSelect,
  });
}

export async function toggleFlow(companyId: string, id: string, isActive: boolean) {
  const flow = await prisma.chatFlow.findFirst({ where: { id, companyId }, select: flowSelect });
  if (!flow) throw new AppError("Flujo no encontrado", 404);

  let warnings: ValidationResult["warnings"] = [];
  if (isActive) {
    const validation = validateFlow(nodesOf(flow), edgesOf(flow), {
      knownFlowIds: await knownFlowIds(companyId),
    });
    if (validation.errors.length) {
      throw new AppError("El flujo tiene errores y no se puede activar", 422, {
        code: "FLOW_INVALID",
        details: { errors: validation.errors, warnings: validation.warnings },
      });
    }
    warnings = validation.warnings;
  }

  const updated = await prisma.chatFlow.update({ where: { id }, data: { isActive }, select: flowSelect });
  return { flow: updated, warnings };
}

export async function validateFlowDraft(companyId: string, nodes: FlowNode[], edges: FlowEdge[]) {
  return validateFlow(nodes, edges, { knownFlowIds: await knownFlowIds(companyId) });
}

export async function deleteFlow(companyId: string, id: string) {
  const existing = await prisma.chatFlow.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Flujo no encontrado", 404);

  // ¿Otros flujos lo referencian en un Control de Flujo → Transferir?
  const others = await prisma.chatFlow.findMany({
    where: { companyId, id: { not: id } },
    select: { id: true, name: true, nodes: true },
  });
  const referencedBy = others.filter((f) =>
    nodesOf(f).some(
      (n) => n.type === "flow-control" && (n.data as FlowControlData).targetFlowId === id,
    ),
  );
  if (referencedBy.length) {
    throw new AppError("Otros flujos transfieren a este flujo. Quita esas conexiones primero.", 409, {
      code: "FLOW_REFERENCED",
      details: { referencedBy: referencedBy.map((f) => ({ id: f.id, name: f.name })) },
    });
  }

  await prisma.chatFlow.delete({ where: { id } });
}
