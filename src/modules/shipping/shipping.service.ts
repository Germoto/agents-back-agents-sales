/**
 * Configuración de «Envíos» de un negocio (Company.shippingConfig).
 *
 * La usan el panel (Empresa → Envíos), el asistente de arranque y el Copiloto. Vive
 * aparte del perfil de la empresa para que guardar «Empresa» nunca la pise.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { symbolFor } from "../../lib/currency";
import {
  DEFAULT_NOTIFY_MESSAGES,
  NOTIFY_EVENTS,
  NOTIFY_EVENT_LABELS,
  NOTIFY_VARIABLES,
  defaultShippingConfig,
  describeShippingConfig,
  normalizeShippingConfig,
  shippingConfigSchema,
  type ShippingConfig,
} from "./shipping-config";

/** Rubros que pueden encender «Envíos» en esta fase. */
const SHIPPING_VERTICALS = new Set(["PHYSICAL_GOODS"]);

async function loadCompany(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { vertical: true, currency: true, shippingConfig: true },
  });
  if (!company) throw new AppError("Empresa no encontrada", 404);
  return company;
}

function present(company: { vertical: string; currency: string; shippingConfig: unknown }) {
  const config = normalizeShippingConfig(company.shippingConfig) ?? defaultShippingConfig();
  return {
    // false = el rubro del negocio no usa «Envíos» (el panel oculta la pestaña).
    available: SHIPPING_VERTICALS.has(company.vertical),
    config,
    // Frases interpretadas para el cuadro «Con esta configuración:».
    summary: describeShippingConfig(config, symbolFor(company.currency)),
    variables: NOTIFY_VARIABLES,
    eventLabels: NOTIFY_EVENT_LABELS,
    defaultMessages: DEFAULT_NOTIFY_MESSAGES,
  };
}

export async function getShippingConfig(companyId: string) {
  return present(await loadCompany(companyId));
}

/** Solo la config ya normalizada (null = apagado o nunca configurado). */
export async function loadShippingConfig(companyId: string): Promise<ShippingConfig | null> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { shippingConfig: true } });
  return normalizeShippingConfig(company?.shippingConfig);
}

/** Guarda la configuración COMPLETA (el panel envía todo el objeto). */
export async function saveShippingConfig(companyId: string, input: unknown) {
  const company = await loadCompany(companyId);
  const parsed = shippingConfigSchema.parse(input ?? {});
  if (parsed.enabled && !SHIPPING_VERTICALS.has(company.vertical)) {
    throw new AppError("«Envíos» solo está disponible para el rubro de productos físicos.", 400);
  }
  // Un aviso con el texto de fábrica se guarda vacío: así una mejora futura de la
  // plantilla llega a quien nunca la personalizó.
  const notifications: Record<string, { enabled: boolean; message: string }> = {};
  for (const ev of NOTIFY_EVENTS) {
    const n = parsed.notifications?.[ev];
    const message = (n?.message ?? "").trim();
    notifications[ev] = { enabled: !!n?.enabled, message: message === DEFAULT_NOTIFY_MESSAGES[ev] ? "" : message };
  }
  const stored = { ...parsed, notifications };
  await prisma.company.update({
    where: { id: companyId },
    data: { shippingConfig: stored as unknown as Prisma.InputJsonValue },
  });
  return present({ ...company, shippingConfig: stored });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Fusión profunda: los objetos se combinan, las listas y los valores sueltos se reemplazan. */
export function mergeShippingConfig(current: unknown, patch: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    base[key] = isPlainObject(value) ? mergeShippingConfig(base[key], value) : value;
  }
  return base;
}

/** Cambia solo lo indicado y conserva el resto (Copiloto y asistente de arranque). */
export async function patchShippingConfig(companyId: string, patch: unknown) {
  const company = await loadCompany(companyId);
  const current = normalizeShippingConfig(company.shippingConfig) ?? defaultShippingConfig();
  return saveShippingConfig(companyId, mergeShippingConfig(current, patch));
}
