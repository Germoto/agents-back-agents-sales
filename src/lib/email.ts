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

/** Enmascara para logs: "juan.perez@gmail.com" → "j***@gmail.com". */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
