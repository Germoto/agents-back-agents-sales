/**
 * Entidades HTML en texto de chat. Un cliente nunca escribe `&quot;` a mano y el
 * modelo no debería emitirlas: si aparecen (gateway que escapa, texto copiado de
 * una web, modelo que imita el historial) se decodifican antes de usar/enviar.
 * Solo decodifica: nunca escapa.
 */

const NAMED: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  iexcl: "¡",
  iquest: "¿",
  ntilde: "ñ",
  Ntilde: "Ñ",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  uuml: "ü",
  Uuml: "Ü",
};

const ENTITY_RE = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,15});/gi;

/** `&quot;` → `"`, `&#39;` → `'`, `&#x27;` → `'`, `&amp;` → `&` (dos pasadas: `&amp;quot;`). */
export function decodeEntities(text: string): string {
  if (!text || !text.includes("&")) return text;
  const once = (s: string) =>
    s.replace(ENTITY_RE, (m, body: string) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      const named = NAMED[body] ?? NAMED[body.toLowerCase()];
      return named ?? m;
    });
  const first = once(text);
  return first.includes("&") ? once(first) : first;
}

/** true si el texto contiene alguna entidad reconocible (para logs/diagnóstico). */
export function hasEntities(text: string): boolean {
  if (!text || !text.includes("&")) return false;
  ENTITY_RE.lastIndex = 0;
  return ENTITY_RE.test(text);
}
