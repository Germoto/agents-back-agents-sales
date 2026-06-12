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
