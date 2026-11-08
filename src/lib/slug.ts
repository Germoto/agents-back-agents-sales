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

/** Normaliza un nombre a slug (minúsculas, sin tildes, guiones). "" si no queda nada. */
export function slugify(name: string, maxLen = 40): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

/**
 * Slug de empresa único y válido como subdominio a partir del nombre del negocio.
 * Si choca con una empresa existente o con una palabra reservada, agrega -2, -3…
 * `exists` recibe el candidato y responde si ya está tomado.
 */
export async function uniqueCompanySlug(name: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  let base = slugify(name, 36);
  if (base.length < 3) base = `${base}${base ? "-" : ""}negocio`.replace(/^-/, "");
  if (!STORE_SLUG_RE.test(base)) base = "negocio";
  for (let i = 1; i <= 200; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (RESERVED_SLUGS.has(candidate) || !STORE_SLUG_RE.test(candidate)) continue;
    if (!(await exists(candidate))) return candidate;
  }
  // Último recurso: sufijo aleatorio.
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}
