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
}) {
  const config = await prisma.agentConfig.upsert({
    where: { companyId },
    update: {
      ...data,
      temperature: data.temperature.toString(),
    },
    create: {
      companyId,
      ...data,
      temperature: data.temperature.toString(),
    },
  });

  return mapAgentConfig(config);
}
