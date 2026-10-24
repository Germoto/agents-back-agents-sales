/**
 * Biblioteca de recursos del negocio para el copiloto/MCP: TODA la multimedia
 * reutilizable en un solo listado. Además de los archivos de producto (ProductFile)
 * recoge la que vive solo como URL dentro de JSON: pasos de recordatorios (generales
 * en AgentConfig.followupConfig y por producto en Product.reminderConfig), banner y
 * mensajes adicionales de presentación, mensajes post-venta y enganche.
 *
 * Es el espejo de `src/shared/lib/resource-library.ts` del panel (misma agrupación,
 * mismas etiquetas de origen, mismo dedupe por URL) para que el copiloto vea lo
 * mismo que la pestaña Recursos del chat, el selector de campañas y la tienda.
 */
import { prisma } from "../../lib/prisma";
import { normalizeFollowupList, normalizeFollowups } from "../../lib/product";
import { listProducts } from "./products.service";
import { stepsFrom } from "../agent/reminder-templates";

export type ResourceType = "IMAGE" | "VIDEO" | "AUDIO" | "PDF" | "OTHER";
export type ResourceOrigin = "archivo" | "recordatorio" | "presentacion" | "postventa";

export interface ResourceEntry {
  url: string;
  tipo: ResourceType;
  nombre: string;
  /** Archivo: su descripción. JSON: el mensaje del paso. */
  descripcion: string;
  origen: ResourceOrigin;
  /** "Archivo del producto", "Recordatorio carrito abandonado · paso 2", … */
  detalle: string;
  productoId: string | null;
  /** Nombre del producto; "Recordatorios generales" para los del negocio. */
  producto: string;
  /** Otros lugares donde se usa la misma URL. */
  tambienEn: string[];
  /** Solo archivos: privado = enlace firmado, no apto para campañas ni tienda. */
  privado?: boolean;
}

export const GENERAL_REMINDERS_LABEL = "Recordatorios generales";

const REMINDER_LABEL: Record<string, string> = {
  abandonedCart: "Recordatorio carrito abandonado",
  leftOnRead: "Recordatorio dejado en visto",
};

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|3gp)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|opus)(\?|$)/i;

/** Acepta "IMAGE"/"image"/"document"… y cae a la extensión de la URL. */
export function normalizeResourceType(mediaType: string | null | undefined, url: string): ResourceType {
  const upper = (mediaType ?? "").trim().toUpperCase();
  if (upper === "IMAGE" || upper === "VIDEO" || upper === "AUDIO" || upper === "PDF" || upper === "OTHER") return upper;
  if (upper === "DOCUMENT") return /\.pdf(\?|$)/i.test(url) ? "PDF" : "OTHER";
  if (IMAGE_EXT.test(url)) return "IMAGE";
  if (VIDEO_EXT.test(url)) return "VIDEO";
  if (AUDIO_EXT.test(url)) return "AUDIO";
  return /\.pdf(\?|$)/i.test(url) ? "PDF" : "OTHER";
}

export function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url, "http://x").pathname;
    const name = decodeURIComponent(path.split("/").pop() ?? "");
    return name || "archivo";
  } catch {
    return "archivo";
  }
}

function asObj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

class Collector {
  readonly entries: ResourceEntry[] = [];
  private readonly byUrl = new Map<string, ResourceEntry>();

  push(e: Omit<ResourceEntry, "tambienEn">) {
    const k = e.url.split("?")[0].trim();
    if (!k) return;
    const existing = this.byUrl.get(k);
    if (existing) {
      const where = e.productoId && e.productoId !== existing.productoId ? `${e.detalle} (${e.producto})` : e.detalle;
      if (!existing.tambienEn.includes(where)) existing.tambienEn.push(where);
      // Un archivo "gana" como entrada principal aunque aparezca después.
      if (e.origen === "archivo" && existing.origen !== "archivo") {
        const also = [existing.detalle, ...existing.tambienEn.filter((x) => x !== where)];
        Object.assign(existing, e, { tambienEn: also });
      }
      return;
    }
    const entry: ResourceEntry = { ...e, tambienEn: [] };
    this.byUrl.set(k, entry);
    this.entries.push(entry);
  }

  reminders(cfg: unknown, productoId: string | null, producto: string) {
    const c = asObj(cfg);
    for (const type of Object.keys(REMINDER_LABEL)) {
      const steps = stepsFrom(asObj(c[type])) ?? [];
      steps.forEach((step, i) => {
        const url = (step.mediaUrl ?? "").trim();
        if (!url) return;
        this.push({
          url,
          tipo: normalizeResourceType(step.mediaType, url),
          nombre: fileNameFromUrl(url),
          descripcion: step.message.trim(),
          origen: "recordatorio",
          detalle: `${REMINDER_LABEL[type]} · paso ${i + 1}`,
          productoId,
          producto,
        });
      });
    }
  }
}

export interface ResourceFilter {
  productId?: string | null;
  tipo?: ResourceType | null;
}

export async function listResourceLibrary(companyId: string, filter: ResourceFilter = {}): Promise<ResourceEntry[]> {
  const [products, config] = await Promise.all([
    listProducts(companyId),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { followupConfig: true } }),
  ]);
  const col = new Collector();

  for (const p of products) {
    for (const f of p.files) {
      if (!f.url) continue;
      col.push({
        url: f.url,
        tipo: f.type,
        nombre: f.originalName || fileNameFromUrl(f.url),
        descripcion: (f.description ?? "").trim(),
        origen: "archivo",
        detalle: "Archivo del producto",
        productoId: p.id,
        producto: p.name,
        privado: f.privateDownload,
      });
    }
    const banner = (p.presentationMessageMediaUrl ?? "").trim();
    if (banner) {
      col.push({
        url: banner,
        tipo: normalizeResourceType(p.presentationMessageMediaType, banner),
        nombre: fileNameFromUrl(banner),
        descripcion: (p.presentationMessage ?? "").trim(),
        origen: "presentacion",
        detalle: "Banner de presentación",
        productoId: p.id,
        producto: p.name,
      });
    }
    normalizeFollowupList(p.presentationFollowups as never).forEach((m, i) => {
      const url = m.mediaUrl.trim();
      if (!url) return;
      col.push({
        url,
        tipo: normalizeResourceType(m.mediaType, url),
        nombre: fileNameFromUrl(url),
        descripcion: m.message.trim(),
        origen: "presentacion",
        detalle: `Mensaje adicional de presentación ${i + 1}`,
        productoId: p.id,
        producto: p.name,
      });
    });
    if (p.digitalDelivery) {
      normalizeFollowups(p.digitalDelivery).forEach((m, i) => {
        const url = m.mediaUrl.trim();
        if (!url) return;
        col.push({
          url,
          tipo: normalizeResourceType(m.mediaType, url),
          nombre: fileNameFromUrl(url),
          descripcion: m.message.trim(),
          origen: "postventa",
          detalle: `Mensaje post-venta ${i + 1}`,
          productoId: p.id,
          producto: p.name,
        });
      });
      const cross = (p.digitalDelivery.crossSellPitchMediaUrl ?? "").trim();
      if (cross) {
        col.push({
          url: cross,
          tipo: normalizeResourceType(p.digitalDelivery.crossSellPitchMediaType, cross),
          nombre: fileNameFromUrl(cross),
          descripcion: (p.digitalDelivery.crossSellPitch ?? "").trim(),
          origen: "postventa",
          detalle: "Enganche post-venta",
          productoId: p.id,
          producto: p.name,
        });
      }
    }
    col.reminders(p.reminderConfig, p.id, p.name);
  }

  col.reminders(config?.followupConfig, null, GENERAL_REMINDERS_LABEL);

  return col.entries.filter(
    (e) => (!filter.productId || e.productoId === filter.productId) && (!filter.tipo || e.tipo === filter.tipo),
  );
}
