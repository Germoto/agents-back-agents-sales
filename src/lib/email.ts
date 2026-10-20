/**
 * Validación/normalización de direcciones de correo (un solo criterio para
 * todo el backend: entrega por correo, fichas de cliente, reportes).
 */

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

/** Devuelve el correo normalizado (trim + lowercase) o null si no es válido. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v.length > 160 || !EMAIL_RE.test(v)) return null;
  return v;
}

export function isValidEmail(value: unknown): boolean {
  return normalizeEmail(value) !== null;
}

const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Extrae el PRIMER correo que aparezca dentro de un texto libre (ej. "Enviar a:
 * juan@gmail.com", "mi correo es juan@gmail.com porfa"). Devuelve null si no hay.
 */
export function extractEmail(text: unknown): string | null {
  if (typeof text !== "string" || !text) return null;
  const m = text.match(EMAIL_IN_TEXT_RE);
  if (!m) return null;
  for (const cand of m) {
    const n = normalizeEmail(cand.replace(/[.,;:)]+$/, ""));
    if (n) return n;
  }
  return null;
}

/** Enmascara para logs: "juan.perez@gmail.com" → "j***@gmail.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
