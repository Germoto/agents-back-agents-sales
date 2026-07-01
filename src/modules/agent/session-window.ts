/**
 * Ventana de 24h de la API oficial de Meta: los mensajes libres solo pueden
 * enviarse dentro de las 24h siguientes al último mensaje del CLIENTE; fuera
 * de esa ventana Meta exige una plantilla aprobada (error 131047 si no).
 *
 * SMS Tools no tiene esta restricción — estos helpers solo aplican cuando el
 * sender de la empresa es provider META. El agente conversacional no se ve
 * afectado (siempre responde a un mensaje recién recibido); esto protege los
 * envíos "en frío": recordatorios del scheduler y campañas masivas.
 */

import { prisma } from "../../lib/prisma";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export { META_WINDOW_REASON } from "../../lib/meta-wa-client";

/** true si el cliente escribió (role USER) hace menos de 24h. */
export async function isWithin24hWindow(companyId: string, customerId: string): Promise<boolean> {
  const last = await prisma.conversationMessage.findFirst({
    where: { companyId, customerId, role: "USER" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return !!last && Date.now() - last.createdAt.getTime() < WINDOW_MS;
}

/**
 * Plantilla de Meta configurada como respaldo para envíos fuera de ventana
 * (opcional). `params` son los valores de {{1}}, {{2}}, ... del cuerpo; admiten
 * el placeholder {nombre} del cliente.
 */
export type MetaTemplateConfig = {
  name: string;
  language: string;
  params: string[];
};

export function parseMetaTemplate(raw: unknown): MetaTemplateConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  if (!name) return null;
  const language = String(o.language ?? "es").trim() || "es";
  const params = Array.isArray(o.params) ? o.params.map((p) => String(p ?? "")) : [];
  return { name, language, params };
}

/** Sustituye {nombre} en los parámetros de la plantilla. */
export function substituteTemplateParams(params: string[], vars: { nombre?: string | null }): string[] {
  const nombre = (vars.nombre ?? "").trim() || "cliente";
  return params.map((p) => p.replace(/\{nombre\}/gi, nombre));
}
