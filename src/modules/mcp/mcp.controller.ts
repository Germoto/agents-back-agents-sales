/**
 * Servidor MCP remoto de FlowApp (Streamable HTTP, respuestas JSON simples).
 *
 * Implementación mínima del protocolo a mano (JSON-RPC 2.0 sobre POST): el SDK
 * oficial es ESM-first y este backend es CommonJS; para un servidor SOLO de
 * tools basta con initialize / tools/list / tools/call / ping. Las tools son
 * EXACTAMENTE las del Copiloto (runCopilotTool, scoped por companyId, sin
 * secretos) y las instructions del servidor son el mismo system del Copiloto,
 * así el Claude del cliente hereda guía de rubro, reglas de confirmación y
 * honestidad de acciones.
 */

import type { Request, Response } from "express";
import {
  TOOLS,
  runCopilotTool,
  buildSystem,
  type CopilotAttachment,
} from "../copilot/copilot.controller";
import { saveBufferAsProductFile } from "../product-files/product-files.service";
import { resolveMcpToken } from "./mcp.service";

const PROTOCOL_FALLBACK = "2025-03-26";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

function rpcResult(id: number | string | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * adjuntar_foto_producto por MCP: no hay "adjuntos de la conversación", así que
 * una URL http(s) externa se descarga (solo imágenes, ≤8MB), se guarda como
 * archivo propio del tenant y se registra en el mapa para que la tool la
 * acepte como adjunto legítimo. Devuelve los args (re-escritos) a usar.
 */
async function prepareMcpAttachment(
  companyId: string,
  args: Record<string, unknown>,
  attachmentsByUrl: Map<string, CopilotAttachment>,
): Promise<Record<string, unknown>> {
  const rawUrl = String(args.url ?? "").trim();
  if (!/^https?:\/\//i.test(rawUrl)) return args;
  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`no se pudo descargar la imagen (HTTP ${res.status})`);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) throw new Error(`la URL no es una imagen (content-type ${mime || "desconocido"})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("la imagen está vacía o pesa más de 8MB");
  const originalName = rawUrl.split("?")[0].split("/").pop() || "imagen";
  const saved = await saveBufferAsProductFile(companyId, buffer, mime, originalName);
  attachmentsByUrl.set(saved.url, saved);
  return { ...args, url: saved.url };
}

export async function mcpHttpController(req: Request, res: Response) {
  const token = String(req.params.token ?? "").trim() || (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const companyId = await resolveMcpToken(token);
  if (!companyId) {
    return res.status(401).json(rpcError(null, -32001, "Token MCP inválido o conector deshabilitado"));
  }

  // Streamable HTTP: GET abriría un stream SSE (no soportado — servidor solo-tools).
  if (req.method !== "POST") return res.status(405).json(rpcError(null, -32000, "Método no soportado; usa POST"));

  const body = req.body as JsonRpcRequest | JsonRpcRequest[];
  // Los batches no se usan en la práctica por los clientes MCP; se rechazan claro.
  if (Array.isArray(body)) return res.status(400).json(rpcError(null, -32600, "Batch JSON-RPC no soportado"));
  const { id = null, method, params = {} } = body ?? {};

  // Notificaciones (sin id): aceptar y no responder contenido.
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return res.status(202).end();
  }

  try {
    switch (method) {
      case "initialize": {
        const clientVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_FALLBACK;
        const instructions = await buildSystem(companyId).catch(() => "");
        return res.json(
          rpcResult(id, {
            protocolVersion: clientVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "FlowApp", version: "1.0.0" },
            ...(instructions ? { instructions } : {}),
          }),
        );
      }

      case "ping":
        return res.json(rpcResult(id, {}));

      case "tools/list":
        return res.json(
          rpcResult(id, {
            tools: TOOLS.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              inputSchema: t.function.parameters,
            })),
          }),
        );

      case "tools/call": {
        const name = String(params.name ?? "");
        let args = (params.arguments ?? {}) as Record<string, unknown>;
        const attachmentsByUrl = new Map<string, CopilotAttachment>();
        if (name === "adjuntar_foto_producto") {
          args = await prepareMcpAttachment(companyId, args, attachmentsByUrl);
        }
        const { result } = await runCopilotTool(companyId, name, args, attachmentsByUrl);
        let isError = false;
        try {
          isError = (JSON.parse(result) as { ok?: boolean }).ok === false;
        } catch {
          /* resultado no-JSON: se entrega tal cual */
        }
        return res.json(rpcResult(id, { content: [{ type: "text", text: result }], isError }));
      }

      default:
        return res.json(rpcError(id, -32601, `Método no soportado: ${method ?? "(vacío)"}`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "error interno";
    // Errores de tool como resultado isError (el modelo puede autocorregirse).
    return res.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true }));
  }
}
