/**
 * fetch endurecido para URLs configuradas por el dueño (Acciones HTTP):
 * solo https, sin destinos internos (anti-SSRF), timeout, sin seguir
 * redirecciones, respuesta acotada y reintentos solo en fallos transitorios.
 */

import dns from "dns/promises";
import net from "net";
import { AppError } from "./app-error";

export const SAFE_FETCH_MAX_TIMEOUT_MS = 30_000;
export const SAFE_FETCH_MAX_BYTES = 256 * 1024;

export interface SafeFetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  /** Reintentos adicionales (≤ 2) solo ante error de red, timeout o 5xx. */
  retries?: number;
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
  attempts: number;
}

export class SafeFetchTimeout extends Error {
  constructor(ms: number) {
    super(`La API no respondió en ${Math.round(ms / 1000)} s`);
    this.name = "SafeFetchTimeout";
  }
}

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  if (p[0] === 10) return true;
  if (p[0] === 127) return true;
  if (p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  if (p[0] >= 224) return true; // multicast / reservado
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
  if (v.startsWith("::ffff:")) return isPrivateIpv4(v.slice(7));
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

/** Valida protocolo y destino. Lanza AppError 422 con un motivo claro. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(`URL inválida: ${raw.slice(0, 120)}`, 422);
  }
  if (url.protocol !== "https:") {
    throw new AppError("Solo se permiten URLs https://", 422);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new AppError("No se permiten destinos internos (localhost / .internal)", 422);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new AppError("No se permiten direcciones IP privadas o internas", 422);
    return url;
  }
  let addresses: { address: string }[] = [];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new AppError(`No se pudo resolver el dominio ${host}`, 422);
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new AppError(`El dominio ${host} apunta a una red interna: bloqueado`, 422);
  }
  return url;
}

async function readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * Ejecuta la petición. Lanza `SafeFetchTimeout` o `Error` de red tras agotar
 * reintentos; devuelve también los 4xx/5xx (el caller decide qué es "ok").
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const url = await assertSafeUrl(rawUrl);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 15_000, 1_000), SAFE_FETCH_MAX_TIMEOUT_MS);
  const maxBytes = Math.min(opts.maxBytes ?? SAFE_FETCH_MAX_BYTES, SAFE_FETCH_MAX_BYTES);
  const retries = Math.min(Math.max(opts.retries ?? 0, 0), 2);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body ?? undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status >= 300 && res.status < 400) {
        return { status: res.status, contentType: "", text: "", truncated: false, attempts: attempt };
      }
      if (res.status >= 500 && attempt <= retries) {
        lastError = new Error(`HTTP ${res.status}`);
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const { text, truncated } = await readLimited(res, maxBytes);
      return {
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
        text,
        truncated,
        attempts: attempt,
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = controller.signal.aborted ? new SafeFetchTimeout(timeoutMs) : err;
      if (attempt <= retries) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Fallo de red");
}
