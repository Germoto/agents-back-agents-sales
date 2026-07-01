/**
 * Cifrado en reposo de credenciales sensibles (hoy: metaAccessToken).
 * AES-256-GCM con clave derivada de CREDENTIALS_ENC_KEY (sha256). Formato
 * almacenado: "enc:v1:" + base64(iv | authTag | ciphertext). Si la env no está
 * definida se guarda en texto plano; decryptCredential hace passthrough de
 * valores sin prefijo, así que plano y cifrado conviven sin migración de datos.
 */

import crypto from "crypto";
import { env } from "../config/env";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer | null {
  if (!env.CREDENTIALS_ENC_KEY) return null;
  return crypto.createHash("sha256").update(env.CREDENTIALS_ENC_KEY).digest();
}

export function encryptCredential(plain: string): string {
  const k = key();
  if (!k || !plain) return plain;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptCredential(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // valor en texto plano
  const k = key();
  if (!k) {
    console.error("[credentials-crypto] hay un valor cifrado pero CREDENTIALS_ENC_KEY no está definida");
    return "";
  }
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch (err) {
    console.error("[credentials-crypto] no se pudo descifrar la credencial:", err instanceof Error ? err.message : err);
    return "";
  }
}
