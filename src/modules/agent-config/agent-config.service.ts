import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { decryptCredential, encryptCredential } from "../../lib/credentials-crypto";
import { providerOf } from "../../lib/ai-providers";
import { getPlatformAiQuota } from "../agent/platform-ai-quota";
import { VoiceError, cleanSpokenText, generateVoiceNote, listVoices, voiceModelHasTags, voiceTextProblem, type VoiceSettings } from "../voice/voice-tts";
import { VOICE_LIMITS } from "../voice/voice-limits";

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
  unknownHandoff?: boolean;
  humanChatAlerts?: boolean;
  crmToolConfig?: unknown;
  groupToolConfig?: unknown;
  stickerToolConfig?: unknown;
  voiceToolConfig?: unknown;
  voiceApiKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
} | null) {
  if (!config) {
    return null;
  }

  const { openaiApiKey, transcriptionApiKey, voiceApiKey, ...rest } = config;
  return {
    ...rest,
    aiProvider: config.aiProvider ?? "OPENAI",
    // OWN = key del dueño; PLATFORM = IA de prueba de FlowApp (con tope; ver platformAi).
    aiKeySource: (config as { aiKeySource?: string }).aiKeySource === "PLATFORM" ? "PLATFORM" : "OWN",
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
    unknownHandoff: config.unknownHandoff ?? false,
    humanChatAlerts: config.humanChatAlerts ?? true,
    crmToolConfig: config.crmToolConfig ?? null,
    groupToolConfig: config.groupToolConfig ?? null,
    stickerToolConfig: config.stickerToolConfig ?? null,
    voiceToolConfig: config.voiceToolConfig ?? null,
    // La clave de ElevenLabs tampoco sale del backend.
    voiceKeySet: !!voiceApiKey,
    voiceApiKeyMasked: maskApiKey(voiceApiKey ?? null),
  };
}

/** Agrega el estado de la IA de prueba (usados/tope) cuando la key es de la plataforma. */
async function withPlatformAi<T extends { companyId: string; aiKeySource: string } | null>(mapped: T) {
  if (!mapped || mapped.aiKeySource !== "PLATFORM") return mapped ? { ...mapped, platformAi: null } : mapped;
  const q = await getPlatformAiQuota(mapped.companyId);
  return { ...mapped, platformAi: { used: q.used, cap: q.cap, exhausted: q.exhausted } };
}

export async function getAgentConfig(companyId: string) {
  const config = await prisma.agentConfig.findUnique({ where: { companyId } });
  return withPlatformAi(mapAgentConfig(config));
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
  unknownHandoff?: boolean;
  humanChatAlerts?: boolean;
  catalogMode?: string;
  keywordMode?: string;
  trackStock?: boolean;
  catalogMediaMode?: string;
  catalogMediaUrl?: string | null;
  catalogMediaType?: string | null;
  catalogMediaFileName?: string | null;
  /** undefined = no tocar; null = apagar la herramienta de CRM del agente. */
  crmToolConfig?: Record<string, unknown> | null;
  /** undefined = no tocar; null = apagar la herramienta de grupos del agente. */
  groupToolConfig?: Record<string, unknown> | null;
  /** undefined = no tocar; null = apagar la herramienta de stickers del agente. */
  stickerToolConfig?: Record<string, unknown> | null;
  /** undefined = no tocar; null = apagar las notas de voz del agente. */
  voiceToolConfig?: Record<string, unknown> | null;
  /** Clave de ElevenLabs: solo se guarda si viene escrita. */
  voiceApiKey?: string;
}) {
  const aiProvider = data.aiProvider ?? "OPENAI";
  const typedKey = Boolean(data.openaiApiKey && data.openaiApiKey.trim());
  // La key guardada pertenece al proveedor con el que se guardó: al cambiar de
  // proveedor hay que ingresar la key nueva (la anterior no sirve).
  const existing = await prisma.agentConfig.findUnique({
    where: { companyId },
    select: { aiProvider: true, openaiApiKey: true, voiceApiKey: true },
  });
  const typedVoiceKey = data.voiceApiKey?.trim() ?? "";
  const voiceOn = (data.voiceToolConfig as { enabled?: boolean } | null | undefined)?.enabled === true;
  if (voiceOn && !typedVoiceKey && !existing?.voiceApiKey) {
    throw new AppError("Para activar las notas de voz ingresa la clave de ElevenLabs.", 422);
  }
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
    // campo conserva la actual); se cifra en reposo (AES-256-GCM). Una key
    // propia reemplaza la IA de prueba de la plataforma (se acaba el tope).
    ...(typedKey ? { openaiApiKey: encryptCredential(data.openaiApiKey!.trim()), aiKeySource: "OWN" } : {}),
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
    ...(typeof data.unknownHandoff === "boolean" ? { unknownHandoff: data.unknownHandoff } : {}),
    ...(typeof data.humanChatAlerts === "boolean" ? { humanChatAlerts: data.humanChatAlerts } : {}),
    ...(data.catalogMode ? { catalogMode: data.catalogMode } : {}),
    ...(data.keywordMode ? { keywordMode: data.keywordMode } : {}),
    ...(typeof data.trackStock === "boolean" ? { trackStock: data.trackStock } : {}),
    ...(data.catalogMediaMode ? { catalogMediaMode: data.catalogMediaMode } : {}),
    // url/type/fileName: undefined = no tocar; null = limpiar la carta guardada.
    ...(data.catalogMediaUrl !== undefined ? { catalogMediaUrl: data.catalogMediaUrl || null } : {}),
    ...(data.catalogMediaType !== undefined ? { catalogMediaType: data.catalogMediaType || null } : {}),
    ...(data.catalogMediaFileName !== undefined ? { catalogMediaFileName: data.catalogMediaFileName || null } : {}),
    ...(data.crmToolConfig !== undefined
      ? { crmToolConfig: data.crmToolConfig === null ? Prisma.JsonNull : (data.crmToolConfig as Prisma.InputJsonValue) }
      : {}),
    ...(data.groupToolConfig !== undefined
      ? { groupToolConfig: data.groupToolConfig === null ? Prisma.JsonNull : (data.groupToolConfig as Prisma.InputJsonValue) }
      : {}),
    ...(data.stickerToolConfig !== undefined
      ? { stickerToolConfig: data.stickerToolConfig === null ? Prisma.JsonNull : (data.stickerToolConfig as Prisma.InputJsonValue) }
      : {}),
    ...(data.voiceToolConfig !== undefined
      ? { voiceToolConfig: data.voiceToolConfig === null ? Prisma.JsonNull : (data.voiceToolConfig as Prisma.InputJsonValue) }
      : {}),
    ...(typedVoiceKey ? { voiceApiKey: encryptCredential(typedVoiceKey) } : {}),
  };
  const config = await prisma.agentConfig.upsert({
    where: { companyId },
    update: core,
    create: { companyId, ...core },
  });
  return withPlatformAi(mapAgentConfig(config));
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

// ---------------------------------------------------------------------------
// Notas de voz: voces de la cuenta y audio de prueba
// ---------------------------------------------------------------------------

/** Clave de ElevenLabs del negocio, descifrada. "" si no hay. */
export async function loadVoiceApiKey(companyId: string): Promise<string> {
  const row = await prisma.agentConfig.findUnique({ where: { companyId }, select: { voiceApiKey: true } });
  return decryptCredential(row?.voiceApiKey ?? null);
}

async function requireVoiceKey(companyId: string, typed?: string): Promise<string> {
  const key = typed?.trim() || (await loadVoiceApiKey(companyId));
  if (!key) throw new AppError("Ingresa la clave de ElevenLabs.", 400);
  return key;
}

function asVoiceAppError(err: unknown): never {
  if (err instanceof VoiceError) throw new AppError(err.message, 400);
  throw err;
}

/** Voces de la cuenta de ElevenLabs (con la clave guardada, o la recién escrita aún sin guardar). */
export async function listAgentVoices(companyId: string, typedKey?: string) {
  const key = await requireVoiceKey(companyId, typedKey);
  try {
    return { voices: await listVoices(key) };
  } catch (err) {
    return asVoiceAppError(err);
  }
}

/** Genera un audio de prueba con los ajustes en pantalla. No lo envía a nadie. */
export async function testAgentVoice(
  companyId: string,
  input: VoiceSettings & { text: string },
  typedKey?: string,
) {
  const key = await requireVoiceKey(companyId, typedKey);
  const text = cleanSpokenText(input.text, { keepTags: voiceModelHasTags(input.model) });
  const problem = voiceTextProblem(text, VOICE_LIMITS.maxChars.max);
  if (problem) throw new AppError(problem, 400);
  try {
    const note = await generateVoiceNote(companyId, key, input, text);
    return { url: note.url, seconds: note.seconds };
  } catch (err) {
    return asVoiceAppError(err);
  }
}
