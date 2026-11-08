import { BusinessVertical } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { encryptCredential, decryptCredential } from "../../lib/credentials-crypto";
import { mpGetMe } from "../../lib/mercadopago-client";
import { AI_PROVIDERS, providerOf, type AiProviderId } from "../../lib/ai-providers";

const PLATFORM_CONFIG_ID = "global";

// Fuente de verdad de rubros + etiquetas (backend). El frontend tiene su propio
// catálogo de labels; aquí basta value+label para responder al superadmin.
export const VERTICALS: { value: BusinessVertical; label: string }[] = [
  { value: "INFOPRODUCT", label: "Infoproductos (cursos, ebooks, accesos)" },
  { value: "PHYSICAL_GOODS", label: "Productos físicos" },
  { value: "RESTAURANT", label: "Restaurante / comida" },
  { value: "STREAMER", label: "Streamer / suscripciones" },
  { value: "SERVICE", label: "Servicios" },
  { value: "REAL_ESTATE", label: "Inmobiliaria (venta y alquiler de inmuebles)" },
  { value: "OTHER", label: "Otro" },
];

const ALL_VERTICALS: BusinessVertical[] = VERTICALS.map((v) => v.value);

/**
 * Devuelve los rubros habilitados globalmente. Si el singleton no existe todavía
 * lo crea perezosamente con TODOS los rubros (no-breaking).
 */
export async function getEnabledVerticals(): Promise<BusinessVertical[]> {
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
  });
  if (config) {
    return config.enabledVerticals;
  }
  const created = await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update: {},
    create: { id: PLATFORM_CONFIG_ID, enabledVerticals: ALL_VERTICALS },
  });
  return created.enabledVerticals;
}

// Animaciones disponibles para el landing público (Three.js en el frontend).
export const LANDING_SCENES: { value: string; label: string; description: string }[] = [
  { value: "constelacion", label: "Constelación", description: "Icosaedro, anillo y partículas en órbita" },
  { value: "ondas", label: "Ondas", description: "Malla de partículas que ondula como un océano" },
  { value: "nebulosa", label: "Nebulosa", description: "Espiral de partículas tipo galaxia" },
  { value: "tunel", label: "Túnel", description: "Partículas que viajan hacia la cámara" },
  { value: "lluvia", label: "Lluvia digital", description: "Partículas cayendo con deriva" },
  { value: "rejilla", label: "Rejilla en perspectiva", description: "Piso de cuadrícula que ondula y sigue al mouse" },
  { value: "red", label: "Red de nodos", description: "Puntos que se conectan cuando se acercan" },
  { value: "aurora", label: "Aurora", description: "Cintas de luz suaves que fluyen" },
  { value: "orbes", label: "Orbes", description: "Esferas difusas flotando con profundidad" },
  { value: "hexagonos", label: "Hexágonos", description: "Panal que se ilumina en ondas" },
  { value: "flujo", label: "Flujo", description: "Corrientes de partículas atraídas por el mouse" },
  { value: "malla", label: "Malla", description: "Cuadrícula fina que se deforma en ondas, con puntos que laten" },
  { value: "esferas", label: "Esferas", description: "Esferas wireframe anidadas girando" },
  { value: "anillos", label: "Anillos", description: "Ondas concéntricas que se expanden desde el centro" },
  { value: "estrellas", label: "Estrellas", description: "Cielo de estrellas que titilan con parallax" },
  { value: "helice", label: "Hélice", description: "Doble hélice de puntos girando" },
  { value: "cubos", label: "Cubos", description: "Cubos wireframe flotando y rotando" },
  { value: "nudo", label: "Nudo", description: "Nudo toroidal wireframe girando" },
  { value: "lineas", label: "Líneas de sonido", description: "Líneas horizontales que ondulan con el mouse" },
  { value: "burbujas", label: "Burbujas", description: "Círculos que suben y se desvanecen" },
  { value: "terreno", label: "Terreno", description: "Relieve low-poly que avanza hacia ti" },
  { value: "enjambre", label: "Enjambre", description: "Partículas que persiguen al mouse" },
  { value: "latido", label: "Latido", description: "Grilla de puntos que pulsa en ondas" },
];

const LANDING_SCENE_VALUES = LANDING_SCENES.map((s) => s.value);

export async function getLandingScene(): Promise<string> {
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { landingScene: true },
  });
  return config?.landingScene ?? "constelacion";
}

// Acentos sugeridos para la landing (el superadmin puede escribir cualquier #rrggbb).
export const LANDING_ACCENTS: { value: string; label: string }[] = [
  { value: "#3451b2", label: "Índigo (marca)" },
  { value: "#1d6fa5", label: "Azul" },
  { value: "#1f7a4d", label: "Verde WhatsApp" },
  { value: "#0f766e", label: "Teal" },
  { value: "#c2410c", label: "Naranja" },
  { value: "#8a2a4a", label: "Vino" },
  { value: "#3f4756", label: "Gris" },
  { value: "#5b4bd6", label: "Violeta" },
];
export const DEFAULT_LANDING_ACCENT = "#3451b2";
const HEX_RE = /^#[0-9a-f]{6}$/i;

export async function getLandingAccent(): Promise<string> {
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { landingAccent: true },
  });
  const value = config?.landingAccent ?? DEFAULT_LANDING_ACCENT;
  return HEX_RE.test(value) ? value.toLowerCase() : DEFAULT_LANDING_ACCENT;
}

export async function setLandingAccent(accent: string): Promise<string> {
  if (!HEX_RE.test(accent)) throw new AppError("Color de acento no válido (usa #rrggbb).", 400);
  const config = await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update: { landingAccent: accent.toLowerCase() },
    create: { id: PLATFORM_CONFIG_ID, enabledVerticals: ALL_VERTICALS, landingAccent: accent.toLowerCase() },
  });
  return config.landingAccent ?? DEFAULT_LANDING_ACCENT;
}

/** Config de la landing que ve el superadmin y, sin secretos, el público. */
export async function getLandingConfig(): Promise<{ scene: string; accent: string }> {
  const [scene, accent] = await Promise.all([getLandingScene(), getLandingAccent()]);
  return { scene, accent };
}

export async function setLandingScene(scene: string): Promise<string> {
  if (!LANDING_SCENE_VALUES.includes(scene)) {
    throw new AppError("Animación de landing no válida.", 400);
  }
  const config = await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update: { landingScene: scene },
    create: { id: PLATFORM_CONFIG_ID, enabledVerticals: ALL_VERTICALS, landingScene: scene },
  });
  return config.landingScene;
}

// ---------------------------------------------------------------------------
// Agente de ventas de la PLATAFORMA (chat del landing que capta tenants).
// El agente vive como un tenant oculto; aquí solo el puntero + conocimiento.
// ---------------------------------------------------------------------------

export async function getSalesAgentPointer(): Promise<{
  companyId: string | null;
  knowledge: Record<string, string> | null;
}> {
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { salesAgentCompanyId: true, salesAgentKnowledge: true },
  });
  return {
    companyId: config?.salesAgentCompanyId ?? null,
    knowledge: (config?.salesAgentKnowledge as Record<string, string> | null) ?? null,
  };
}

export async function setSalesAgentPointer(
  companyId: string,
  knowledge: Record<string, string>,
): Promise<void> {
  await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update: { salesAgentCompanyId: companyId, salesAgentKnowledge: knowledge },
    create: {
      id: PLATFORM_CONFIG_ID,
      enabledVerticals: ALL_VERTICALS,
      salesAgentCompanyId: companyId,
      salesAgentKnowledge: knowledge,
    },
  });
}

/** ¿companyId es el tenant del agente de ventas de la plataforma? (webchat: phone obligatorio) */
export async function isPlatformSalesCompany(companyId: string): Promise<boolean> {
  const { companyId: salesId } = await getSalesAgentPointer();
  return !!salesId && salesId === companyId;
}

/**
 * Token del chat de ventas para el landing público, o null si aún no está listo
 * (sin tenant, chat desactivado o sin API key de OpenAI → sin burbuja).
 */
export async function getPublicSalesChatToken(): Promise<string | null> {
  const { companyId } = await getSalesAgentPointer();
  if (!companyId) return null;
  const [webchat, agent] = await Promise.all([
    prisma.webchatConfig.findUnique({
      where: { companyId },
      select: { enabled: true, token: true },
    }),
    prisma.agentConfig.findUnique({
      where: { companyId },
      select: { openaiApiKey: true },
    }),
  ]);
  if (!webchat?.enabled || !agent?.openaiApiKey) return null;
  return webchat.token;
}

// ---------------------------------------------------------------------------
// Cobros de la PLATAFORMA con Mercado Pago: los tenants pagan su plan y
// recargan créditos solos desde Mi plan. Token de la cuenta MP del dueño.
// ---------------------------------------------------------------------------

function maskToken(token: string): string {
  if (token.length <= 10) return "•••";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/** Uso interno (checkout/webhook): token descifrado + habilitado. */
export async function getPlatformMpBilling(): Promise<{ enabled: boolean; accessToken: string | null }> {
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { mpBillingEnabled: true, mpBillingAccessToken: true },
  });
  const token = config?.mpBillingAccessToken ? decryptCredential(config.mpBillingAccessToken) : null;
  return { enabled: !!config?.mpBillingEnabled && !!token, accessToken: token };
}

/** Vista para la consola: nunca expone el token en claro. */
export async function getPlatformMpBillingAdmin() {
  const { enabled, accessToken } = await getPlatformMpBilling();
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { mpBillingEnabled: true },
  });
  return {
    enabled: config?.mpBillingEnabled ?? false,
    connected: !!accessToken,
    maskedToken: accessToken ? maskToken(accessToken) : null,
  };
}

export async function setPlatformMpBilling(data: { accessToken?: string | null; enabled: boolean }) {
  const update: Record<string, unknown> = { mpBillingEnabled: data.enabled };
  let account: { nickname: string } | null = null;

  if (data.accessToken === null) {
    update.mpBillingAccessToken = null;
    update.mpBillingEnabled = false;
  } else if (data.accessToken && data.accessToken.trim()) {
    const token = data.accessToken.trim();
    try {
      const me = await mpGetMe(token);
      account = { nickname: me.nickname };
    } catch (err) {
      throw new AppError(
        `El Access Token no es válido: ${err instanceof Error ? err.message : "error de Mercado Pago"}`,
        400,
      );
    }
    update.mpBillingAccessToken = encryptCredential(token);
  }

  await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update,
    create: { id: PLATFORM_CONFIG_ID, enabledVerticals: ALL_VERTICALS, ...update },
  });
  return { ...(await getPlatformMpBillingAdmin()), account };
}

/**
 * Actualiza la lista global de rubros habilitados. Exige al menos uno.
 */
export async function setEnabledVerticals(
  list: BusinessVertical[],
): Promise<BusinessVertical[]> {
  // Dedup preservando el orden canónico de VERTICALS.
  const set = new Set(list);
  const normalized = ALL_VERTICALS.filter((v) => set.has(v));
  if (normalized.length === 0) {
    throw new AppError("Debes habilitar al menos un rubro.", 400);
  }
  const config = await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update: { enabledVerticals: normalized },
    create: { id: PLATFORM_CONFIG_ID, enabledVerticals: normalized },
  });
  return config.enabledVerticals;
}

// ---------------------------------------------------------------------------
// Avisos al dueño de la PLATAFORMA (nuevos pre-registros, etc.)
// ---------------------------------------------------------------------------

export async function getNotifyConfig(): Promise<{ alertEmail: string | null; alertPhone: string | null }> {
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { alertEmail: true, alertPhone: true },
  });
  return { alertEmail: config?.alertEmail ?? null, alertPhone: config?.alertPhone ?? null };
}

export async function updateNotifyConfig(input: {
  alertEmail?: string | null;
  alertPhone?: string | null;
}): Promise<{ alertEmail: string | null; alertPhone: string | null }> {
  const alertEmail = input.alertEmail !== undefined ? input.alertEmail?.trim() || null : undefined;
  const alertPhone = input.alertPhone !== undefined ? input.alertPhone?.replace(/\D/g, "") || null : undefined;
  if (alertEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) {
    throw new AppError("Email de avisos no válido", 400);
  }
  const config = await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update: {
      ...(alertEmail !== undefined ? { alertEmail } : {}),
      ...(alertPhone !== undefined ? { alertPhone } : {}),
    },
    create: {
      id: PLATFORM_CONFIG_ID,
      enabledVerticals: ALL_VERTICALS,
      ...(alertEmail !== undefined ? { alertEmail } : {}),
      ...(alertPhone !== undefined ? { alertPhone } : {}),
    },
    select: { alertEmail: true, alertPhone: true },
  });
  return { alertEmail: config.alertEmail ?? null, alertPhone: config.alertPhone ?? null };
}

// ---------------------------------------------------------------------------
// Registro en un solo paso (activación automática) + IA de prueba de la plataforma
// ---------------------------------------------------------------------------

const REGISTRATION_SELECT = {
  autoActivateRegistrations: true,
  autoActivateTrialDays: true,
  trialAiEnabled: true,
  trialAiProvider: true,
  trialAiModel: true,
  trialAiApiKey: true,
  trialAiMessageCap: true,
} as const;

export interface RegistrationSettingsAdmin {
  autoActivate: boolean;
  trialDays: number;
  trialAi: {
    enabled: boolean;
    provider: AiProviderId;
    model: string;
    /** Key enmascarada (nunca completa); null si no hay. */
    maskedKey: string | null;
    connected: boolean;
    messageCap: number;
  };
}

function trialAiModelFor(provider: AiProviderId, model: string | null | undefined): string {
  const info = AI_PROVIDERS[provider];
  const wanted = model?.trim();
  return wanted && info.models.some((m) => m.id === wanted) ? wanted : info.models[0].id;
}

export async function getRegistrationSettingsAdmin(): Promise<RegistrationSettingsAdmin> {
  const row = await prisma.platformConfig.findUnique({ where: { id: PLATFORM_CONFIG_ID }, select: REGISTRATION_SELECT });
  const provider = providerOf(row?.trialAiProvider).id;
  const key = decryptCredential(row?.trialAiApiKey);
  return {
    autoActivate: row?.autoActivateRegistrations ?? false,
    trialDays: row?.autoActivateTrialDays ?? 7,
    trialAi: {
      enabled: row?.trialAiEnabled ?? false,
      provider,
      model: trialAiModelFor(provider, row?.trialAiModel),
      maskedKey: key ? maskToken(key) : null,
      connected: !!key,
      messageCap: row?.trialAiMessageCap ?? 200,
    },
  };
}

/** Lo que necesita el formulario público de /registro para adaptar textos y rubros. */
export async function getRegistrationPublicConfig(): Promise<{
  autoActivate: boolean;
  trialDays: number;
  verticals: { value: BusinessVertical; label: string }[];
}> {
  const [row, enabled] = await Promise.all([
    prisma.platformConfig.findUnique({
      where: { id: PLATFORM_CONFIG_ID },
      select: { autoActivateRegistrations: true, autoActivateTrialDays: true },
    }),
    getEnabledVerticals(),
  ]);
  return {
    autoActivate: row?.autoActivateRegistrations ?? false,
    trialDays: row?.autoActivateTrialDays ?? 7,
    verticals: VERTICALS.filter((v) => enabled.includes(v.value)),
  };
}

export async function getAutoActivateConfig(): Promise<{ enabled: boolean; trialDays: number }> {
  const row = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { autoActivateRegistrations: true, autoActivateTrialDays: true },
  });
  return { enabled: row?.autoActivateRegistrations ?? false, trialDays: row?.autoActivateTrialDays ?? 7 };
}

/** Key de IA de prueba lista para aprovisionar (ya cifrada); null si está apagada o no hay key. */
export async function getTrialAiProvision(): Promise<{ provider: AiProviderId; model: string; apiKeyEncrypted: string } | null> {
  const row = await prisma.platformConfig.findUnique({ where: { id: PLATFORM_CONFIG_ID }, select: REGISTRATION_SELECT });
  if (!row?.trialAiEnabled || !row.trialAiApiKey) return null;
  const provider = providerOf(row.trialAiProvider).id;
  return { provider, model: trialAiModelFor(provider, row.trialAiModel), apiKeyEncrypted: row.trialAiApiKey };
}

/** Tope global de respuestas de IA de prueba por cliente. */
export async function getTrialAiMessageCap(): Promise<number> {
  const row = await prisma.platformConfig.findUnique({ where: { id: PLATFORM_CONFIG_ID }, select: { trialAiMessageCap: true } });
  return row?.trialAiMessageCap ?? 200;
}

export async function setRegistrationSettings(input: {
  autoActivate?: boolean;
  trialDays?: number;
  trialAi?: {
    enabled?: boolean;
    provider?: AiProviderId;
    model?: string;
    /** undefined = no cambiar; null = quitar; string = reemplazar */
    apiKey?: string | null;
    messageCap?: number;
  };
}): Promise<RegistrationSettingsAdmin> {
  const current = await getRegistrationSettingsAdmin();
  const update: Record<string, unknown> = {};
  if (input.autoActivate !== undefined) update.autoActivateRegistrations = input.autoActivate;
  if (input.trialDays !== undefined) update.autoActivateTrialDays = input.trialDays;

  const ai = input.trialAi;
  const provider = ai?.provider ?? current.trialAi.provider;
  const model = trialAiModelFor(provider, ai?.model ?? (ai?.provider && ai.provider !== current.trialAi.provider ? null : current.trialAi.model));
  let keyChanged = false;
  if (ai) {
    if (ai.enabled !== undefined) update.trialAiEnabled = ai.enabled;
    if (ai.messageCap !== undefined) update.trialAiMessageCap = ai.messageCap;
    update.trialAiProvider = provider;
    update.trialAiModel = model;
    if (ai.apiKey === null) {
      update.trialAiApiKey = null;
      update.trialAiEnabled = false;
      keyChanged = true;
    } else if (ai.apiKey && ai.apiKey.trim()) {
      update.trialAiApiKey = encryptCredential(ai.apiKey.trim());
      keyChanged = true;
    }
    if (ai.enabled && !current.trialAi.connected && !(ai.apiKey && ai.apiKey.trim())) {
      throw new AppError("Para activar la IA de prueba primero ingresa una API key.", 400);
    }
  }

  const saved = await prisma.platformConfig.upsert({
    where: { id: PLATFORM_CONFIG_ID },
    update,
    create: { id: PLATFORM_CONFIG_ID, enabledVerticals: ALL_VERTICALS, ...update },
    select: REGISTRATION_SELECT,
  });

  // Los clientes que usan la key de prueba siguen la key/proveedor/modelo de la
  // plataforma: al cambiar cualquiera de los tres se actualizan en bloque.
  const providerChanged = provider !== current.trialAi.provider || model !== current.trialAi.model;
  if ((keyChanged || providerChanged) && saved.trialAiApiKey) {
    await prisma.agentConfig.updateMany({
      where: { aiKeySource: "PLATFORM" },
      data: { openaiApiKey: saved.trialAiApiKey, aiProvider: provider, openaiModel: model },
    });
  }
  return getRegistrationSettingsAdmin();
}
