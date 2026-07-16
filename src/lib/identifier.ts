import { z } from "zod";

// ---------------------------------------------------------------------------
// Identificadores de login: celular O usuario en el mismo campo.
// Regla anti-ambigüedad: el username SIEMPRE contiene al menos una letra,
// así un identifier de solo dígitos resuelve como celular y uno con letra
// como usuario. Los usernames se normalizan a lowercase en la app.
// ---------------------------------------------------------------------------

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{4,20}$/, "Usuario inválido: 4-20 caracteres (letras, números, punto, guion)")
  .refine((v) => /[a-z]/.test(v), "El usuario debe contener al menos una letra");

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Solo dígitos (para comparar celulares con o sin +/espacios). */
export function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}
