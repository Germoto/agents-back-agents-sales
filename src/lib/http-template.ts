/**
 * Plantillas y aplanado para las Acciones HTTP.
 *
 * - `renderVars` reemplaza `{{clave}}` / `{{clave.con.puntos}}` (sintaxis de los
 *   flujos) por el valor de un mapa plano de strings; dentro de un cuerpo JSON se
 *   escapa el valor para no romper el JSON.
 * - `renderSingleBrace` hace lo mismo con `{clave}` (sintaxis de las plantillas de
 *   entrega de productos), sin tocar el spintax `{a|b|c}`.
 * - `flattenJson` convierte una respuesta JSON en claves planas con puntos
 *   (`api.data.key`, `api.items.0.id`) para guardarlas como variables (strings).
 */

export type FlatVars = Record<string, string>;

const MAX_FLAT_KEYS = 200;
const MAX_FLAT_DEPTH = 5;
const MAX_VALUE_LEN = 2000;

function clip(v: string): string {
  return v.length > MAX_VALUE_LEN ? v.slice(0, MAX_VALUE_LEN) : v;
}

/** Aplana cualquier valor JSON bajo `prefix` (p. ej. "api"). */
export function flattenJson(value: unknown, prefix: string, out: FlatVars = {}, depth = 0): FlatVars {
  if (Object.keys(out).length >= MAX_FLAT_KEYS) return out;
  if (value === null || value === undefined) {
    out[prefix] = "";
    return out;
  }
  if (typeof value !== "object") {
    out[prefix] = clip(String(value));
    return out;
  }
  if (depth >= MAX_FLAT_DEPTH) {
    out[prefix] = clip(JSON.stringify(value));
    return out;
  }
  if (Array.isArray(value)) {
    out[`${prefix}.length`] = String(value.length);
    value.forEach((item, i) => flattenJson(item, `${prefix}.${i}`, out, depth + 1));
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) {
    out[prefix] = "{}";
    return out;
  }
  for (const [k, v] of entries) {
    if (Object.keys(out).length >= MAX_FLAT_KEYS) break;
    const key = k.replace(/[^\w.-]/g, "_");
    flattenJson(v, `${prefix}.${key}`, out, depth + 1);
  }
  return out;
}

const DOUBLE_RE = /\{\{\s*([\w][\w.-]*)\s*\}\}/g;
const SINGLE_RE = /\{([a-zA-Z_][\w.-]*)\}/g;

function jsonEscape(v: string): string {
  // JSON.stringify agrega comillas: se quitan para insertar dentro de un literal.
  return JSON.stringify(v).slice(1, -1);
}

/** `{{clave}}` → valor (vacío si no existe). `jsonSafe` escapa para cuerpos JSON. */
export function renderVars(text: string, vars: FlatVars, opts: { jsonSafe?: boolean } = {}): string {
  if (!text) return text;
  return text.replace(DOUBLE_RE, (_m, key: string) => {
    const v = vars[key] ?? "";
    return opts.jsonSafe ? jsonEscape(v) : v;
  });
}

/** `{clave}` → valor SOLO si la clave existe en `vars` (deja intacto el spintax y otros {…}). */
export function renderSingleBrace(text: string, vars: FlatVars): string {
  if (!text) return text;
  return text.replace(SINGLE_RE, (m, key: string) => (key in vars ? vars[key] : m));
}

/** Claves de un mapa plano, ordenadas (para mostrar al dueño qué variables hay). */
export function flatKeys(vars: FlatVars): string[] {
  return Object.keys(vars).sort((a, b) => a.localeCompare(b));
}
