/**
 * Asistente de arranque (/bienvenida) y plantillas por rubro.
 * - applyVerticalPresets: siembra prompt, reglas, CRM, respuestas rápidas y
 *   recordatorios del rubro en cuentas nuevas (idempotente) y los reemplaza
 *   si el dueño cambia de rubro antes de tener productos.
 * - getOnboarding / updateOnboarding: paso en curso, borrador, saltos y menú.
 *   El avance real sale de getSetupStatus (productos, pagos, prueba, WhatsApp).
 */
import { Prisma, type BusinessVertical } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { getSetupStatus, type SetupStatus } from "../setup/setup.service";
import { LEGACY_DEFAULT_PROMPT, presetFor } from "./vertical-presets";

const MAX_SKIPS = 3;

export async function applyVerticalPresets(companyId: string, vertical: BusinessVertical): Promise<void> {
  const [company, agent, onboarding] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { _count: { select: { products: true, crms: true, quickReplies: true } } } }),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { basePrompt: true } }),
    prisma.companyOnboarding.findUnique({ where: { companyId } }),
  ]);
  if (!company) return;
  const previous = onboarding?.presetVertical ? presetFor(onboarding.presetVertical as BusinessVertical) : null;
  const preset = presetFor(vertical);

  // Cambio de rubro sin productos: retirar lo que dejó la plantilla anterior si
  // el dueño no lo tocó (tablero sin tarjetas, respuestas con el mismo comando).
  if (previous && onboarding?.presetVertical !== vertical && company._count.products === 0) {
    const board = await prisma.crm.findFirst({ where: { companyId, name: previous.crm.name }, select: { id: true, _count: { select: { cards: true } } } });
    if (board && board._count.cards === 0) await prisma.crm.delete({ where: { id: board.id } });
    await prisma.quickReply.deleteMany({ where: { companyId, command: { in: previous.quickReplies.map((q) => q.command) } } });
    await prisma.customerTag.deleteMany({ where: { companyId, name: { in: previous.crm.tags.map((t) => t.name) }, links: { none: {} } } });
  }

  const promptUntouched = !agent?.basePrompt?.trim() || agent.basePrompt === LEGACY_DEFAULT_PROMPT || (previous ? agent.basePrompt === previous.basePrompt : false);
  if (promptUntouched) {
    await prisma.agentConfig.updateMany({
      where: { companyId },
      data: {
        basePrompt: preset.basePrompt,
        rules: preset.rules as unknown as Prisma.InputJsonValue,
        followupConfig: preset.reminders as unknown as Prisma.InputJsonValue,
      },
    });
  }

  const crmCount = await prisma.crm.count({ where: { companyId } });
  if (crmCount === 0) {
    const crm = await prisma.crm.create({ data: { companyId, name: preset.crm.name, color: preset.crm.color, sortOrder: 0 } });
    await prisma.crmColumn.createMany({
      data: preset.crm.columns.map((c, i) => ({ crmId: crm.id, companyId, name: c.name, color: c.color ?? null, sortOrder: i })),
    });
  }
  for (const tag of preset.crm.tags) {
    await prisma.customerTag.upsert({
      where: { companyId_name: { companyId, name: tag.name } },
      update: {},
      create: { companyId, name: tag.name, color: tag.color },
    });
  }

  const qrCount = await prisma.quickReply.count({ where: { companyId } });
  if (qrCount === 0) {
    const category = await prisma.quickReplyCategory.upsert({
      where: { companyId_name: { companyId, name: "Básicas" } },
      update: {},
      create: { companyId, name: "Básicas", sortOrder: 0 },
    });
    for (const q of preset.quickReplies) {
      await prisma.quickReply.create({
        data: { companyId, categoryId: category.id, title: q.title, command: q.command, messages: [{ type: "text", text: q.text }] as unknown as Prisma.InputJsonValue },
      }).catch(() => undefined);
    }
  }

  await prisma.companyOnboarding.upsert({
    where: { companyId },
    update: { presetVertical: vertical },
    create: { companyId, presetVertical: vertical },
  });
}

export interface OnboardingState {
  step: number;
  draft: Record<string, unknown> | null;
  skipCount: number;
  fullMenu: boolean;
  completedAt: string | null;
  /** Productos + pagos + agente listos (WhatsApp no bloquea el cierre del asistente). */
  complete: boolean;
  /** Abrir el asistente al entrar. */
  showAssistant: boolean;
  /** Menú reducido mientras la puesta en marcha no esté completa. */
  simpleMenu: boolean;
  /** Primer paso con algo pendiente (1 negocio, 2 productos, 3 cobros, 4 prueba). */
  nextStep: number;
  setup: SetupStatus;
}

function stepDone(setup: SetupStatus, key: string): boolean {
  return setup.steps.find((s) => s.key === key)?.done ?? true;
}

export async function getOnboarding(companyId: string): Promise<OnboardingState> {
  const [row, setup] = await Promise.all([
    prisma.companyOnboarding.findUnique({ where: { companyId } }),
    getSetupStatus(companyId),
  ]);
  const products = stepDone(setup, "products");
  const payments = stepDone(setup, "payments");
  const agent = stepDone(setup, "agent");
  const tested = stepDone(setup, "test");
  const complete = Boolean(row?.completedAt) || (products && payments && agent && tested);
  // Cuentas anteriores al asistente (sin fila) con todo hecho: nunca lo ven.
  const legacyComplete = !row && setup.complete;
  const nextStep = !products ? Math.max(2, Math.min(row?.step ?? 1, 2)) : !payments ? 3 : !tested ? 4 : 4;
  const step = row ? Math.min(Math.max(row.step, 1), 4) : 1;
  const skipCount = row?.skipCount ?? 0;
  const fullMenu = row?.fullMenu ?? false;
  const simpleMenu = !legacyComplete && !complete && !fullMenu;
  const showAssistant = !legacyComplete && !complete && !fullMenu && skipCount < MAX_SKIPS;
  return {
    step,
    draft: (row?.draft as Record<string, unknown> | null) ?? null,
    skipCount,
    fullMenu,
    completedAt: row?.completedAt?.toISOString() ?? null,
    complete,
    showAssistant,
    simpleMenu,
    nextStep: row && row.step > 1 && !products ? row.step : nextStep,
    setup,
  };
}

export async function updateOnboarding(
  companyId: string,
  input: { step?: number; draft?: Record<string, unknown> | null; skipped?: boolean; fullMenu?: boolean; completed?: boolean; restart?: boolean },
): Promise<OnboardingState> {
  if (input.step !== undefined && (input.step < 1 || input.step > 4)) throw new AppError("Paso inválido", 400);
  const data: Prisma.CompanyOnboardingUncheckedUpdateInput = {};
  if (input.step !== undefined) data.step = input.step;
  if (input.draft !== undefined) data.draft = input.draft === null ? Prisma.JsonNull : (input.draft as Prisma.InputJsonValue);
  if (input.skipped) {
    data.skipCount = { increment: 1 };
    data.lastSkippedAt = new Date();
  }
  if (input.fullMenu !== undefined) data.fullMenu = input.fullMenu;
  if (input.completed) data.completedAt = new Date();
  if (input.restart) {
    data.completedAt = null;
    data.skipCount = 0;
    data.step = 1;
    data.draft = Prisma.JsonNull;
  }
  await prisma.companyOnboarding.upsert({
    where: { companyId },
    update: data,
    create: {
      companyId,
      step: typeof input.step === "number" ? input.step : 1,
      draft: input.draft ? (input.draft as Prisma.InputJsonValue) : undefined,
      skipCount: input.skipped ? 1 : 0,
      lastSkippedAt: input.skipped ? new Date() : undefined,
      fullMenu: input.fullMenu ?? false,
      completedAt: input.completed ? new Date() : undefined,
    },
  });
  return getOnboarding(companyId);
}
