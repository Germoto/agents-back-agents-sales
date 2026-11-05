/**
 * Ejecuta una Acción HTTP (petición configurada por el dueño) con las variables
 * del contexto, registra la ejecución (secretos enmascarados) y devuelve la
 * respuesta aplanada en variables `{{<responseVar>.…}}`.
 *
 * Lo usan: la prueba desde el panel (TEST), el bloque Petición HTTP de los
 * flujos (FLOW), la entrega digital en modo HTTP_ACTION (DELIVERY) y la tool
 * dinámica del agente IA (AGENT).
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { decryptCredential } from "../../lib/credentials-crypto";
import { flattenJson, renderVars, type FlatVars } from "../../lib/http-template";
import { safeFetch, SafeFetchTimeout } from "../../lib/safe-fetch";
import { AppError } from "../../lib/app-error";

export type HttpRunSource = "TEST" | "FLOW" | "DELIVERY" | "AGENT";

export interface KV {
  key: string;
  value: string;
}

export interface RunnableRequest {
  method: string;
  url: string;
  query: KV[];
  headers: KV[];
  bodyType: "NONE" | "JSON" | "FORM" | "RAW";
  body?: string | null;
  responseVar: string;
  retries: number;
}

export interface RunnableConnection {
  baseUrl: string;
  authType: "NONE" | "BEARER" | "HEADER" | "QUERY" | "BASIC";
  authName?: string | null;
  /** Cifrado (tal como está en BD). */
  authSecret?: string | null;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface HttpRunResult {
  ok: boolean;
  status: "OK" | "ERROR" | "TIMEOUT" | "BLOCKED";
  httpStatus: number | null;
  durationMs: number;
  /** Variables aplanadas bajo responseVar (api.status, api.body, api.<campo>…). */
  vars: FlatVars;
  /** Cuerpo recortado (para mostrar en el panel). */
  body: string;
  json: unknown | null;
  error: string | null;
  runId: string | null;
  /** true si se devolvió una ejecución previa por idempotencia. */
  reused: boolean;
}

const BODY_LOG_LIMIT = 4000;
const MASK = "•••";

function asKvList(v: unknown): KV[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && typeof (x as KV).key === "string")
    .map((x) => ({ key: String((x as KV).key), value: String((x as KV).value ?? "") }));
}

function asHeadersMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val ?? "");
  return out;
}

/** Normaliza una fila HttpAction (o una petición inline) a RunnableRequest. */
export function toRunnableRequest(row: {
  method: string;
  url: string;
  query: unknown;
  headers: unknown;
  bodyType: string;
  body?: string | null;
  responseVar?: string | null;
  retries?: number | null;
}): RunnableRequest {
  const bodyType = (["NONE", "JSON", "FORM", "RAW"].includes(row.bodyType) ? row.bodyType : "JSON") as RunnableRequest["bodyType"];
  return {
    method: (row.method || "POST").toUpperCase(),
    url: row.url,
    query: asKvList(row.query),
    headers: asKvList(row.headers),
    bodyType,
    body: row.body ?? null,
    responseVar: row.responseVar?.trim() || "api",
    retries: Math.min(Math.max(row.retries ?? 1, 0), 2),
  };
}

/** Normaliza una fila HttpConnection a RunnableConnection. */
export function toRunnableConnection(row: {
  baseUrl: string;
  authType: string;
  authName?: string | null;
  authSecret?: string | null;
  headers: unknown;
  timeoutMs: number;
} | null | undefined): RunnableConnection | null {
  if (!row) return null;
  return {
    baseUrl: row.baseUrl,
    authType: (["NONE", "BEARER", "HEADER", "QUERY", "BASIC"].includes(row.authType) ? row.authType : "NONE") as RunnableConnection["authType"],
    authName: row.authName ?? null,
    authSecret: row.authSecret ?? null,
    headers: asHeadersMap(row.headers),
    timeoutMs: row.timeoutMs,
  };
}

function joinUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  return `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

function maskValue(v: string, secret: string | null): string {
  if (!v) return v;
  if (secret && v.includes(secret)) return v.split(secret).join(MASK);
  return v;
}

function maskHeaders(h: Record<string, string>, secret: string | null, authName: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "x-api-key" || lk === "api-key" || (authName && lk === authName.toLowerCase())) {
      out[k] = MASK;
    } else {
      out[k] = maskValue(v, secret);
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof SafeFetchTimeout) return err.message;
  if (err instanceof AppError) return err.message;
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `Error de red (${cause.code})`;
    return err.message || "Error de red";
  }
  return "Error desconocido";
}

/**
 * Arma URL, cabeceras y cuerpo a partir de la petición + conexión + variables.
 * Devuelve también la versión enmascarada para el historial.
 */
export function buildHttpRequest(req: RunnableRequest, conn: RunnableConnection | null, vars: FlatVars) {
  const secret = conn?.authSecret ? decryptCredential(conn.authSecret) : "";
  const url = new URL(joinUrl(conn?.baseUrl ?? "", renderVars(req.url, vars)));
  for (const q of req.query) {
    if (!q.key.trim()) continue;
    url.searchParams.set(renderVars(q.key, vars), renderVars(q.value, vars));
  }
  const headers: Record<string, string> = { ...(conn?.headers ?? {}) };
  for (const h of req.headers) {
    if (!h.key.trim()) continue;
    headers[renderVars(h.key, vars)] = renderVars(h.value, vars);
  }
  if (conn && secret) {
    if (conn.authType === "BEARER") headers.Authorization = `Bearer ${secret}`;
    else if (conn.authType === "HEADER") headers[conn.authName?.trim() || "X-API-Key"] = secret;
    else if (conn.authType === "QUERY") url.searchParams.set(conn.authName?.trim() || "api_key", secret);
    else if (conn.authType === "BASIC") headers.Authorization = `Basic ${Buffer.from(`${conn.authName ?? ""}:${secret}`).toString("base64")}`;
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "accept")) headers.Accept = "application/json, text/*;q=0.8, */*;q=0.5";
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")) headers["User-Agent"] = "FlowApp-HttpAction/1.0";

  let body: string | null = null;
  const hasBody = req.method !== "GET" && req.method !== "DELETE" ? req.bodyType !== "NONE" : false;
  if (hasBody) {
    const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (req.bodyType === "JSON") {
      const rendered = renderVars(req.body ?? "{}", vars, { jsonSafe: true });
      try {
        body = JSON.stringify(JSON.parse(rendered.trim() || "{}"));
      } catch {
        throw new AppError("El cuerpo JSON no es válido después de reemplazar las variables. Revisa comillas y comas.", 422);
      }
      if (!hasCt) headers["Content-Type"] = "application/json";
    } else if (req.bodyType === "FORM") {
      // Una línea por campo: clave=valor (con variables).
      const params = new URLSearchParams();
      for (const line of (req.body ?? "").split(/\r?\n/)) {
        const idx = line.indexOf("=");
        if (idx <= 0) continue;
        params.set(renderVars(line.slice(0, idx).trim(), vars), renderVars(line.slice(idx + 1).trim(), vars));
      }
      body = params.toString();
      if (!hasCt) headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      body = renderVars(req.body ?? "", vars);
      if (!hasCt) headers["Content-Type"] = "text/plain; charset=utf-8";
    }
  }

  const maskedUrl = new URL(url.toString());
  if (conn?.authType === "QUERY" && secret) maskedUrl.searchParams.set(conn.authName?.trim() || "api_key", MASK);
  const masked = {
    method: req.method,
    url: maskedUrl.toString(),
    headers: maskHeaders(headers, secret || null, conn?.authName ?? null),
    body: body ? maskValue(body.slice(0, BODY_LOG_LIMIT), secret || null) : null,
  };
  return { url: url.toString(), headers, body, masked, secret: secret || null, timeoutMs: conn?.timeoutMs ?? 15000 };
}

/** Variables de respuesta: <var>.status, <var>.ok, <var>.body y el JSON aplanado bajo <var>. */
export function responseToVars(responseVar: string, status: number, text: string, contentType: string): { vars: FlatVars; json: unknown | null } {
  const vars: FlatVars = {};
  vars[`${responseVar}.status`] = String(status);
  vars[`${responseVar}.ok`] = status >= 200 && status < 300 ? "true" : "false";
  vars[`${responseVar}.body`] = text.slice(0, 2000);
  let json: unknown | null = null;
  const looksJson = contentType.includes("json") || /^\s*[[{]/.test(text);
  if (looksJson && text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (json !== null && typeof json === "object") {
    // El JSON pisa a status/ok/body solo si la API devuelve campos con ese nombre (raro).
    flattenJson(json, responseVar, vars);
  } else if (json !== null) {
    vars[`${responseVar}.value`] = String(json);
  }
  return { vars, json };
}

export interface RunHttpActionOptions {
  companyId: string;
  actionId?: string | null;
  request: RunnableRequest;
  connection: RunnableConnection | null;
  vars: FlatVars;
  source: HttpRunSource;
  refs?: { customerId?: string | null; conversationId?: string | null; receiptId?: string | null; productId?: string | null };
  /** Si existe un run OK con esta clave, se devuelve su resultado sin volver a llamar. */
  idempotencyKey?: string | null;
}

export async function runHttpAction(opts: RunHttpActionOptions): Promise<HttpRunResult> {
  const { request, connection, vars } = opts;
  const responseVar = request.responseVar || "api";

  if (opts.idempotencyKey) {
    const prev = await prisma.httpActionRun.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
    if (prev && prev.status === "OK") {
      const resp = (prev.response ?? {}) as { vars?: FlatVars; body?: string; status?: number };
      return {
        ok: true,
        status: "OK",
        httpStatus: prev.httpStatus,
        durationMs: prev.durationMs,
        vars: resp.vars ?? {},
        body: resp.body ?? "",
        json: null,
        error: null,
        runId: prev.id,
        reused: true,
      };
    }
  }

  const started = Date.now();
  let built: ReturnType<typeof buildHttpRequest> | null = null;
  let result: HttpRunResult;
  try {
    built = buildHttpRequest(request, connection, vars);
    const res = await safeFetch(built.url, {
      method: request.method,
      headers: built.headers,
      body: built.body,
      timeoutMs: built.timeoutMs,
      retries: request.retries,
    });
    const durationMs = Date.now() - started;
    if (res.status >= 300 && res.status < 400) {
      result = { ok: false, status: "ERROR", httpStatus: res.status, durationMs, vars: {}, body: "", json: null, error: `La API redirigió (HTTP ${res.status}); usa la URL final`, runId: null, reused: false };
    } else {
      const { vars: outVars, json } = responseToVars(responseVar, res.status, res.text, res.contentType);
      const ok = res.status >= 200 && res.status < 300;
      result = {
        ok,
        status: ok ? "OK" : "ERROR",
        httpStatus: res.status,
        durationMs,
        vars: outVars,
        body: res.text.slice(0, BODY_LOG_LIMIT),
        json,
        error: ok ? null : `La API respondió HTTP ${res.status}`,
        runId: null,
        reused: false,
      };
    }
  } catch (err) {
    const durationMs = Date.now() - started;
    const blocked = err instanceof AppError && err.statusCode === 422;
    result = {
      ok: false,
      status: err instanceof SafeFetchTimeout ? "TIMEOUT" : blocked ? "BLOCKED" : "ERROR",
      httpStatus: null,
      durationMs,
      vars: {},
      body: "",
      json: null,
      error: errorMessage(err),
      runId: null,
      reused: false,
    };
  }

  // Historial (best-effort). La clave de idempotencia solo se guarda en OK: un
  // fallo no debe impedir reintentar más tarde.
  try {
    const row = await prisma.httpActionRun.create({
      data: {
        companyId: opts.companyId,
        actionId: opts.actionId ?? null,
        source: opts.source,
        customerId: opts.refs?.customerId ?? null,
        conversationId: opts.refs?.conversationId ?? null,
        receiptId: opts.refs?.receiptId ?? null,
        productId: opts.refs?.productId ?? null,
        idempotencyKey: result.ok ? opts.idempotencyKey ?? null : null,
        status: result.status,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        request: (built?.masked ?? { method: request.method, url: request.url, headers: {}, body: null }) as Prisma.InputJsonValue,
        response: result.httpStatus !== null
          ? ({ status: result.httpStatus, body: maskValue(result.body, built?.secret ?? null), vars: result.vars } as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        error: result.error,
      },
      select: { id: true },
    });
    result.runId = row.id;
    if (opts.actionId) {
      await prisma.httpAction
        .update({
          where: { id: opts.actionId },
          data: {
            lastRunAt: new Date(),
            lastRunOk: result.ok,
            ...(result.ok ? { lastResponseKeys: Object.keys(result.vars).slice(0, 200) } : {}),
          },
        })
        .catch(() => undefined);
    }
  } catch (err) {
    console.warn("[http-actions] no se pudo registrar la ejecución:", err instanceof Error ? err.message : err);
  }
  return result;
}
