/**
 * Firma de empresa: nombre que se antepone a TODA salida de mensajes con texto
 * (agente IA, flujos, recordatorios, modo humano y respuestas rápidas).
 *
 * Formato WhatsApp: `*_<firma>:_*` (negrita + itálica) en su propia línea, seguida
 * de una línea en blanco para que no quede pegada al mensaje.
 */

import { prisma } from "../../lib/prisma";

type FirmaConfig = { enabled: boolean; text: string | null };

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: FirmaConfig; expiresAt: number }>();

async function loadFirma(companyId: string): Promise<FirmaConfig> {
  const cached = cache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { firmaEnabled: true, firmaText: true },
  });
  const value: FirmaConfig = {
    enabled: Boolean(company?.firmaEnabled),
    text: company?.firmaText?.trim() || null,
  };
  cache.set(companyId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Invalida la cache (llamar al guardar la config de empresa). */
export function invalidateFirmaCache(companyId: string): void {
  cache.delete(companyId);
}

/**
 * Antepone la firma al texto si la empresa la tiene activa. Devuelve el texto
 * sin cambios si está desactivada, vacía o el mensaje no trae texto.
 */
export async function applyFirma(companyId: string, text: string | null | undefined): Promise<string | null> {
  const value = text ?? null;
  if (!value || !value.trim()) return value;
  const firma = await loadFirma(companyId);
  if (!firma.enabled || !firma.text) return value;
  const prefix = `*_${firma.text}:_*`;
  // Evita duplicar la firma si por alguna razón ya viene anexada.
  if (value.startsWith(prefix)) return value;
  return `${prefix}\n\n${value}`;
}
