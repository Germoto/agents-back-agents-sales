import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { decryptCredential, encryptCredential } from "../../lib/credentials-crypto";
import { providerOf } from "../../lib/ai-providers";

/** Máscara para el panel: la key completa NUNCA sale del backend. */
function maskApiKey(stored: string | null): string | null {
  if (!stored) return null;
  const plain = decryptCredential(stored);
  if (!plain) return null;
  return `•••${plain.slice(-4)}`;
}

function mapAgentConfig(config: {
  id: string;
  companyId: string;
  aiProvider?: string;
  openaiModel: string;
  openaiApiKey: string | null;
  transcriptionApiKey?: string | null;
  temperature: Prisma.Decimal | number | string;
  basePrompt: string;
  salesStyle: string;
  rules: unknown;
  followupConfig?: unknown;
  replyMode?: string;
  testNumbers?: unknown;
  mutedNumbers?: unknown;
  muteAfterSale?: boolean;
  negotiationHandoff?: boolean;
  createdAt: Date;
  updatedAt: Date;
} | null) {
  if (!config) {
    return null;
  }

  const { openaiApiKey, transcriptionApiKey, ...rest } = config;
  return {
    ...rest,
    aiProvider: config.aiProvider ?? "OPENAI",
    // Seguridad: las keys no se exponen; el panel solo sabe si existen (+ máscara).
    apiKeySet: !!openaiApiKey,
    openaiApiKeyMasked: maskApiKey(openaiApiKey),
    transcriptionKeySet: !!transcriptionApiKey,
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
    negotiationHandoff: config.negotiationHandoff ?? false,
  };
}

export async function getAgentConfig(companyId: string) {
  const config = await prisma.agentConfig.findUnique({ where: { companyId } });
  return mapAgentConfig(config);
}

// Guarda solo el NÚCLEO (modelo + prompt). NO toca followupConfig/replyMode/
// testNumbers: esos se manejan en sus propios endpoints (Recordatorios y Pruebas).
export async function upsertAgentConfig(companyId: string, data: {
  aiProvider?: string;
  openaiModel: string;
  openaiApiKey?: string;
  transcriptionApiKey?: string;
  temperature: number;
  basePrompt: string;
  salesStyle: string;
  rules: string[];
  negotiationHandoff?: boolean;
  catalogMode?: string;
  keywordMode?: string;
  trackStock?: boolean;
  catalogMediaMode?: string;
  catalogMediaUrl?: string | null;
  catalogMediaType?: string | null;
  catalogMediaFileName?: string | null;
}) {
  const aiProvider = data.aiProvider ?? "OPENAI";
  const typedKey = Boolean(data.openaiApiKey && data.openaiApiKey.trim());
  // La key guardada pertenece al proveedor con el que se guardó: al cambiar de
  // proveedor hay que ingresar la key nueva (la anterior no sirve).
  const existing = await prisma.agentConfig.findUnique({
    where: { companyId },
    select: { aiProvider: true, openaiApiKey: true },
  });
  if (existing?.openaiApiKey && (existing.aiProvider ?? "OPENAI") !== aiProvider && !typedKey) {
    throw new AppError(
      `Cambiaste el proveedor de IA a ${providerOf(aiProvider).label}: ingresa la API key de ese proveedor.`,
      422,
    );
  }

  const core = {
    aiProvider,
    openaiModel: data.openaiModel,
    // Solo se escribe si el usuario tipeó una key nueva (guardar sin tocar el
    // campo conserva la actual); se cifra en reposo (AES-256-GCM).
    ...(typedKey ? { openaiApiKey: encryptCredential(data.openaiApiKey!.trim()) } : {}),
    ...(data.transcriptionApiKey && data.transcriptionApiKey.trim()
      ? { transcriptionApiKey: encryptCredential(data.transcriptionApiKey.trim()) }
      : {}),
    temperature: data.temperature.toString(),
    basePrompt: data.basePrompt,
    salesStyle: data.salesStyle,
    rules: data.rules as Prisma.InputJsonValue,
    ...(typeof data.negotiationHandoff === "boolean"
      ? { negotiationHandoff: data.negotiationHandoff }
      : {}),
    ...(data.catalogMode ? { catalogMode: data.catalogMode } : {}),
    ...(data.keywordMode ? { keywordMode: data.keywordMode } : {}),
    ...(typeof data.trackStock === "boolean" ? { trackStock: data.trackStock } : {}),
    ...(data.catalogMediaMode ? { catalogMediaMode: data.catalogMediaMode } : {}),
    // url/type/fileName: undefined = no tocar; null = limpiar la carta guardada.
    ...(data.catalogMediaUrl !== undefined ? { catalogMediaUrl: data.catalogMediaUrl || null } : {}),
    ...(data.catalogMediaType !== undefined ? { catalogMediaType: data.catalogMediaType || null } : {}),
    ...(data.catalogMediaFileName !== undefined ? { catalogMediaFileName: data.catalogMediaFileName || null } : {}),
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
