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
  };
}

export async function getAgentConfig(companyId: string) {
  const config = await prisma.agentConfig.findUnique({ where: { companyId } });
  return mapAgentConfig(config);
}

export async function upsertAgentConfig(companyId: string, data: {
  openaiModel: string;
  openaiApiKey: string;
  temperature: number;
  basePrompt: string;
  salesStyle: string;
  rules: string[];
  followupConfig?: Record<string, unknown> | null;
  replyMode?: string;
  testNumbers?: string[];
}) {
  const { followupConfig, testNumbers, replyMode, ...rest } = data;
  const followupValue: Prisma.InputJsonValue | typeof Prisma.JsonNull =
    followupConfig == null ? Prisma.JsonNull : (followupConfig as Prisma.InputJsonValue);
  const testNumbersValue: Prisma.InputJsonValue = (testNumbers ?? []) as Prisma.InputJsonValue;
  const replyModeValue = replyMode === "ALLOWLIST" ? "ALLOWLIST" : "OPEN";

  const config = await prisma.agentConfig.upsert({
    where: { companyId },
    update: {
      ...rest,
      temperature: data.temperature.toString(),
      followupConfig: followupValue,
      replyMode: replyModeValue,
      testNumbers: testNumbersValue,
    },
    create: {
      companyId,
      ...rest,
      temperature: data.temperature.toString(),
      followupConfig: followupValue,
      replyMode: replyModeValue,
      testNumbers: testNumbersValue,
    },
  });

  return mapAgentConfig(config);
}
