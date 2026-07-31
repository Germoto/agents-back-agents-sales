/**
 * Enriquecimiento de leads con la API de identidad de SMS Tools
 * (/api/lead/whatsapp): nombre (push_name), contacto username con número
 * oculto (LID), cuenta de negocio, "about" y foto de perfil.
 *
 * Reglas:
 * - El NÚMERO de WhatsApp jamás se actualiza por esta API (edición manual).
 * - Caché en metadata.waContact.enrichedAt (TTL 7 días) — nunca se llama por
 *   mensaje, solo al crear el lead o con el botón del panel (force).
 * - is_lid=true → push_name es el nombre principal; teléfono real → solo
 *   rellena el nombre si estaba vacío.
 * - La foto llega con URL temporal → se descarga a uploads/avatars/<companyId>/
 *   y se guarda la URL propia; se re-descarga solo si cambió picture_id.
 */

import fs from "fs/promises";
import path from "path";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { smsTools, type SmsToolsLeadInfo } from "../../lib/smstools-client";

const ENRICH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WaContactMeta {
  jid?: string | null;
  isLid?: boolean;
  pushName?: string | null;
  fullName?: string | null;
  businessName?: string | null;
  isBusiness?: boolean;
  about?: string | null;
  pictureId?: string | null;
  enrichedAt?: string;
}

function waContactOf(metadata: unknown): WaContactMeta | null {
  const md = (metadata ?? {}) as { waContact?: WaContactMeta };
  return md.waContact && typeof md.waContact === "object" ? md.waContact : null;
}

/** Descarga la foto de perfil (URL temporal) a uploads/avatars y devuelve la URL propia. */
async function persistAvatar(
  companyId: string,
  customerId: string,
  avatarUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(avatarUrl);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return null;
    const ct = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    const ext = ct === "image/png" ? "png" : ct === "image/webp" ? "webp" : "jpg";
    const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "avatars", companyId);
    await fs.mkdir(dir, { recursive: true });
    // Nombre estable por customer: la foto nueva reemplaza a la anterior.
    const name = `${customerId}.${ext}`;
    await fs.writeFile(path.join(dir, name), buffer);
    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    // Cache-buster: la URL cambia cuando cambia la foto (el archivo se pisa).
    return `${base}/uploads/avatars/${companyId}/${name}?v=${Date.now()}`;
  } catch (err) {
    console.warn("[lead-enrich] no se pudo persistir el avatar:", err instanceof Error ? err.message : err);
    return null;
  }
}

export type EnrichResult =
  | { ok: true; enriched: true }
  | { ok: true; cached: true }
  | { ok: true; noData: true }
  | { ok: false; skipped: "provider" | "customer" };

/**
 * Enriquece un Customer con la identidad de WhatsApp. Best-effort: nunca lanza.
 * `force` ignora el caché (botón del panel).
 */
export async function enrichCustomerFromWhatsapp(
  companyId: string,
  customerId: string,
  opts: { force?: boolean } = {},
): Promise<EnrichResult> {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true, phone: true, name: true, metadata: true, avatarUrl: true },
  });
  if (!customer) return { ok: false, skipped: "customer" };

  // Solo aplica al canal SMS Tools (la API es de Zender); Meta y web no.
  const wa = await prisma.whatsappConfig.findUnique({
    where: { companyId },
    select: { provider: true, apiUrl: true, secret: true, account: true },
  });
  if (!wa || wa.provider !== "SMSTOOLS" || !wa.account || !wa.secret) {
    return { ok: false, skipped: "provider" };
  }
  const phoneDigits = customer.phone.replace(/\D/g, "");
  if (customer.phone.startsWith("web:") || phoneDigits.length < 6) {
    return { ok: false, skipped: "customer" }; // visitante web anónimo u otro sintético
  }

  const existing = waContactOf(customer.metadata);
  if (!opts.force && existing?.enrichedAt) {
    const age = Date.now() - new Date(existing.enrichedAt).getTime();
    if (Number.isFinite(age) && age < ENRICH_TTL_MS) return { ok: true, cached: true };
  }

  const info: SmsToolsLeadInfo | null = await smsTools.getLeadInfo(
    { apiUrl: wa.apiUrl, secret: wa.secret },
    wa.account,
    phoneDigits,
  );

  const now = new Date().toISOString();
  if (!info) {
    // Sin datos (404 o error): registrar el intento para respetar el TTL igual.
    const md = (customer.metadata ?? {}) as Record<string, unknown>;
    await prisma.customer
      .update({
        where: { id: customer.id },
        data: { metadata: { ...md, waContact: { ...(existing ?? {}), enrichedAt: now } } },
      })
      .catch(() => undefined);
    return { ok: true, noData: true };
  }

  const isLid = !!info.is_lid;
  const pushName = (info.push_name ?? "").trim() || null;
  const fullName = (info.full_name ?? info.first_name ?? "").trim() || null;
  const bestName = pushName ?? fullName;

  // Nombre: con is_lid el push_name manda (es la única identidad visible);
  // con teléfono real solo se rellena si estaba vacío. El phone NO se toca.
  let name = customer.name;
  if (bestName) {
    if (isLid) name = bestName;
    else if (!customer.name || !customer.name.trim()) name = bestName;
  }

  // Foto: re-descargar solo si cambió picture_id (o no teníamos avatar).
  let avatarUrl = customer.avatarUrl;
  const pictureId = info.picture_id ?? null;
  if (info.avatar_url && (opts.force || !avatarUrl || pictureId !== (existing?.pictureId ?? null))) {
    const persisted = await persistAvatar(companyId, customer.id, info.avatar_url);
    if (persisted) avatarUrl = persisted;
  }

  const md = (customer.metadata ?? {}) as Record<string, unknown>;
  const waContact: WaContactMeta = {
    jid: info.jid ?? null,
    isLid,
    pushName,
    fullName,
    businessName: (info.business_name ?? "").trim() || null,
    isBusiness: !!info.is_business,
    about: (info.status ?? "").trim() || null,
    pictureId,
    enrichedAt: now,
  };

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      name,
      waIsLid: isLid,
      avatarUrl,
      metadata: { ...md, waContact } as object,
    },
  });

  return { ok: true, enriched: true };
}
