/**
 * Reglas puras para reconocer un sticker fuera del chat (entregas, fichas, respuestas
 * rápidas, campañas, recordatorios, flujos, agente). Un sticker SIEMPRE sale de la
 * galería del negocio (uploads/stickers/{companyId}/…webp): ahí ya está en el formato
 * que exige WhatsApp. Una imagen .webp cualquiera NO es un sticker y sigue saliendo
 * como imagen, igual que antes.
 */

const GALLERY_RE = /\/uploads\/stickers\/[0-9a-f-]{8,}\/[^/?#]+\.webp(?:[?#].*)?$/i;

/** ¿La URL es de la galería de stickers (de cualquier negocio)? */
export function isStickerGalleryUrl(url: string | null | undefined): boolean {
  return GALLERY_RE.test((url ?? "").trim());
}

/** ¿La URL es de la galería de ESTE negocio? */
export function isCompanyStickerUrl(companyId: string, url: string | null | undefined): boolean {
  const u = (url ?? "").trim();
  return isStickerGalleryUrl(u) && u.toLowerCase().includes(`/uploads/stickers/${companyId.toLowerCase()}/`);
}

/** ¿El tipo guardado dice «sticker»? (acepta mayúsculas: "STICKER"). */
export function isStickerType(type: string | null | undefined): boolean {
  return (type ?? "").trim().toLowerCase() === "sticker";
}

/**
 * Tipo con el que sale un adjunto configurado: «sticker» solo si el tipo lo dice Y la
 * URL es de la galería. Un «sticker» con otra URL sale como imagen (nunca se le manda
 * al gateway un sticker que vaya a rechazar).
 */
export function stickerSafeKind<K extends string>(kind: K, url: string | null | undefined): K | "image" {
  if (kind !== "sticker") return kind;
  return isStickerGalleryUrl(url) ? kind : "image";
}

export const STICKER_URL_ERROR = "El sticker debe elegirse de la galería de stickers del negocio";
