import crypto from "crypto";

// Alfabeto sin caracteres ambiguos (sin 0/O, 1/I/L) para códigos legibles
// que se dictan por teléfono o se copian a mano.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomBlock(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Código de vale legible: `PREFIJO-XXXX-XXXX` (prefijo saneado a A-Z/2-9,
 * máx. 12 chars; sin prefijo queda `XXXX-XXXX`). ~1e12 combinaciones por
 * prefijo: colisiones se reintentan contra el unique de la BD.
 */
export function generateVoucherCode(prefix?: string): string {
  const clean = (prefix ?? "")
    .normalize("NFD")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 12);
  const body = `${randomBlock(4)}-${randomBlock(4)}`;
  return clean ? `${clean}-${body}` : body;
}
