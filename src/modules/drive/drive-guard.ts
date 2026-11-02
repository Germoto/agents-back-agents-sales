/**
 * Guarda de sistema (pedido del dueño, 2-nov-2026): un cliente que NO compró el
 * producto no recibe links de CARPETAS de la entrega de Drive, aunque el modelo
 * intente mandarlos. Excepción: las carpetas que el dueño puso como muestra en la
 * ficha (presentación, mensajes adicionales, descripciones de archivos, FAQs,
 * objeciones y recordatorios del producto). Los links de archivos sueltos no se tocan.
 */

import { deliveryDriveRefs, extractDriveRefs } from "../../lib/google-drive";
import { getIndex } from "./drive-index.service";

export const FOLDER_URL_RE = /https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})[^\s)]*/g;

type GuardProduct = {
  id: string;
  slug?: string | null;
  productType?: string | null;
  digitalDelivery?: { instructions?: string | null; followupMessages?: Array<{ message?: string | null }> | null } | null;
  presentationMessage?: string | null;
  presentationFollowups?: Array<{ message?: string | null }> | null;
  files?: Array<{ description?: string | null }> | null;
  faqs?: Array<{ question?: string | null; answer?: string | null }> | null;
  objections?: Array<{ question?: string | null; answer?: string | null }> | null;
  reminderConfig?: Record<string, unknown> | null;
};

type GuardState = { purchasedProductIds?: string[]; status?: string; selectedProductId?: string | null };

/** ¿El cliente ya compró el producto? (comprobantes aprobados; fallback al estado legado). */
export function drivePurchased(state: GuardState, product: { id: string; slug?: string | null }): boolean {
  const purchased = Array.isArray(state.purchasedProductIds) ? state.purchasedProductIds : [];
  if (purchased.includes(product.id) || (product.slug && purchased.includes(product.slug))) return true;
  return !purchased.length && state.status === "ENTREGADO" && (state.selectedProductId === product.id || state.selectedProductId === product.slug);
}

function reminderTexts(cfg: Record<string, unknown> | null | undefined): string[] {
  if (!cfg) return [];
  const out: string[] = [];
  for (const key of ["abandonedCart", "leftOnRead"]) {
    const seq = cfg[key] as { steps?: Array<{ message?: string }> } | undefined;
    for (const st of seq?.steps ?? []) if (st?.message) out.push(st.message);
  }
  return out;
}

/** Carpetas que el dueño comparte como muestra en la ficha del producto (siempre permitidas). */
export function allowedFolderIds(product: GuardProduct): Set<string> {
  const texts: string[] = [
    product.presentationMessage ?? "",
    ...(product.presentationFollowups ?? []).map((f) => f?.message ?? ""),
    ...(product.files ?? []).map((f) => f?.description ?? ""),
    ...(product.faqs ?? []).flatMap((f) => [f?.question ?? "", f?.answer ?? ""]),
    ...(product.objections ?? []).flatMap((o) => [o?.question ?? "", o?.answer ?? ""]),
    ...reminderTexts(product.reminderConfig),
  ];
  const out = new Set<string>();
  for (const t of texts) for (const r of extractDriveRefs(t)) if (r.kind === "folder") out.add(r.id);
  return out;
}

/** Carpetas de la ENTREGA (nivel 0 + docs expandidos + todas las indexadas) menos las permitidas. */
export function blockedFolderIds(product: GuardProduct): Set<string> {
  const out = new Set<string>();
  for (const r of deliveryDriveRefs(product.digitalDelivery)) if (r.kind === "folder") out.add(r.id);
  const idx = getIndex(product.id);
  if (idx) {
    for (const r of idx.rootRefs) if (r.kind === "folder") out.add(r.id);
    for (const e of idx.entries) if (e.isFolder) out.add(e.id);
  }
  for (const id of allowedFolderIds(product)) out.delete(id);
  return out;
}

/** Unión de carpetas bloqueadas de todos los productos digitales que el cliente NO compró. */
export function blockedFolderIdsFor(products: GuardProduct[], state: GuardState): Set<string> {
  const out = new Set<string>();
  for (const p of products) {
    if (p.productType && p.productType !== "digital") continue;
    if (drivePurchased(state, p)) continue;
    for (const id of blockedFolderIds(p)) out.add(id);
  }
  return out;
}

/**
 * Quita del texto las URLs de carpetas bloqueadas. Si una línea solo contenía el
 * link (con viñeta/puntuación), se elimina la línea entera.
 */
export function stripBlockedFolderLinks(text: string, blocked: Set<string>): { text: string; removed: number } {
  if (!text || !blocked.size || !text.includes("drive.google.com")) return { text, removed: 0 };
  let removed = 0;
  const lines = text.split("\n").map((line) => {
    const cleaned = line.replace(FOLDER_URL_RE, (m, id: string) => {
      if (!blocked.has(id)) return m;
      removed++;
      return "";
    });
    if (cleaned === line) return line;
    // Línea que quedó vacía o solo con viñeta/puntuación → fuera.
    return /^[\s•·\-*👉👇⬇️:.,;()\[\]]*$/u.test(cleaned) ? null : cleaned.replace(/[ \t]+$/g, "");
  });
  const out = lines
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, removed };
}
