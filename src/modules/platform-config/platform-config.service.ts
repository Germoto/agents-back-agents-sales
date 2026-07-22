import { BusinessVertical } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

const PLATFORM_CONFIG_ID = "global";

// Fuente de verdad de rubros + etiquetas (backend). El frontend tiene su propio
// catálogo de labels; aquí basta value+label para responder al superadmin.
export const VERTICALS: { value: BusinessVertical; label: string }[] = [
  { value: "INFOPRODUCT", label: "Infoproductos (cursos, ebooks, accesos)" },
  { value: "PHYSICAL_GOODS", label: "Productos físicos" },
  { value: "RESTAURANT", label: "Restaurante / comida" },
  { value: "STREAMER", label: "Streamer / suscripciones" },
  { value: "SERVICE", label: "Servicios" },
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
export const LANDING_SCENES: { value: string; label: string }[] = [
  { value: "constelacion", label: "Constelación (icosaedro + partículas)" },
  { value: "ondas", label: "Ondas (malla de partículas en movimiento)" },
  { value: "nebulosa", label: "Nebulosa (espiral de partículas)" },
  { value: "tunel", label: "Túnel (warp de partículas hacia la cámara)" },
  { value: "lluvia", label: "Lluvia digital (partículas cayendo)" },
];

const LANDING_SCENE_VALUES = LANDING_SCENES.map((s) => s.value);

export async function getLandingScene(): Promise<string> {
  const config = await prisma.platformConfig.findUnique({
    where: { id: PLATFORM_CONFIG_ID },
    select: { landingScene: true },
  });
  return config?.landingScene ?? "constelacion";
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
