import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";

function mapAgentConfig(config: {
  id: string;
  companyId: string;
  openaiModel: string;
  openaiApiKey: string | null;
  temperature: Prisma.Decimal | number | string;
  basePrompt: string;
  salesStyle: string;
  rules: unknown;
  followupConfig?: unknown;
  replyMode?: string;
  testNumbers?: unknown;
  mutedNumbers?: unknown;
  muteAfterSale?: boolean;
  createdAt: Date;
  updatedAt: Date;
} | null) {
  if (!config) {
    return null;
  }

  return {
    ...config,
    temperature: Number(config.temperature),
    rules: Array.isArray(config.rules) ? config.rules.filter((item): item is string => typeof item === "string") : [],
    followupConfig: config.followupConfig ?? null,
    replyMode: config.replyMode ?? "OPEN",
    testNumbers: Array.isArray(config.testNumbers)
      ? config.testNumbers.filter((item): item is string => typeof item === "string")
      : [],
    mutedNumbers: Array.isArray(config.mutedNumbers)
      ? config.mutedNumbers.filter((item): item is string => typeof item === "string")
      : [],
    muteAfterSale: config.muteAfterSale ?? true,
  };
}

export async function getAgentConfig(companyId: string) {
  const config = await prisma.agentConfig.findUnique({ where: { companyId } });
  return mapAgentConfig(config);
}

// Guarda solo el NÚCLEO (modelo + prompt). NO toca followupConfig/replyMode/
// testNumbers: esos se manejan en sus propios endpoints (Recordatorios y Pruebas).
export async function upsertAgentConfig(companyId: string, data: {
  openaiModel: string;
  openaiApiKey: string;
  temperature: number;
  basePrompt: string;
  salesStyle: string;
  rules: string[];
}) {
  const core = {
    openaiModel: data.openaiModel,
    openaiApiKey: data.openaiApiKey,
    temperature: data.temperature.toString(),
    basePrompt: data.basePrompt,
    salesStyle: data.salesStyle,
    rules: data.rules as Prisma.InputJsonValue,
  };
  const config = await prisma.agentConfig.upsert({
    where: { companyId },
    update: core,
    create: { companyId, ...core },
  });
  return mapAgentConfig(config);
}

// Actualiza solo los recordatorios (followupConfig). El registro ya existe (onboarding).
export async function updateAgentReminders(
  companyId: string,
  followupConfig: Record<string, unknown> | null,
) {
  const value: Prisma.InputJsonValue | typeof Prisma.JsonNull =
    followupConfig == null ? Prisma.JsonNull : (followupConfig as Prisma.InputJsonValue);
  const config = await prisma.agentConfig.update({
    where: { companyId },
    data: { followupConfig: value },
  });
  return mapAgentConfig(config);
}

// Actualiza solo la lista de números en atención humana forzada (+flag post-venta).
export async function updateAgentMutedNumbers(
  companyId: string,
  mutedNumbers: string[],
  muteAfterSale?: boolean,
) {
  const normalized = [...new Set((mutedNumbers ?? []).map((n) => n.replace(/\D/g, "")).filter(Boolean))];
  const config = await prisma.agentConfig.update({
    where: { companyId },
    data: {
      mutedNumbers: normalized as Prisma.InputJsonValue,
      ...(typeof muteAfterSale === "boolean" ? { muteAfterSale } : {}),
    },
  });
  return mapAgentConfig(config);
}

// Actualiza solo el modo de respuesta (módulo Pruebas).
export async function updateAgentReplyMode(
  companyId: string,
  replyMode: string,
  testNumbers: string[],
) {
  const config = await prisma.agentConfig.update({
    where: { companyId },
    data: {
      replyMode: replyMode === "ALLOWLIST" ? "ALLOWLIST" : "OPEN",
      testNumbers: (testNumbers ?? []) as Prisma.InputJsonValue,
    },
  });
  return mapAgentConfig(config);
}
