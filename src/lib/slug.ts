/**
 * Slug de empresa usable como subdominio de la tienda web (<slug>.flowapp.pe).
 * Minúsculas, dígitos y guiones; 3-40 caracteres; sin guion al inicio/fin.
 * Las palabras reservadas chocan con hosts de la plataforma.
 */

export const STORE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export const RESERVED_SLUGS = new Set([
  "www", "api", "app", "admin", "mail", "smtp", "ftp", "tienda", "store", "shop", "flowapp",
  "control-room", "control-room-7m4x", "static", "cdn", "assets", "uploads", "webchat", "widget",
  "login", "registro", "dashboard", "panel", "soporte", "ayuda", "status", "ns1", "ns2",
]);

export function isValidStoreSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return STORE_SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** Motivo legible cuando un slug no sirve como subdominio (null si es válido). */
export function storeSlugProblem(slug: string | null | undefined): string | null {
  if (!slug) return "La empresa no tiene identificador.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" es un nombre reservado de la plataforma.`;
  if (!STORE_SLUG_RE.test(slug)) {
    return "Solo minúsculas, números y guiones (3 a 40 caracteres, sin empezar ni terminar con guion).";
  }
  return null;
}
