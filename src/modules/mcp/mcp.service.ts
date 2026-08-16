/**
 * Conector MCP del tenant: token único que expone las tools del Copiloto como
 * servidor MCP remoto (configurar FlowApp desde Claude/Cursor). Patrón de token
 * clonado del chat web. OFF por defecto: el tenant lo activa en Integraciones.
 */

import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";

function newMcpToken(): string {
  return `mcp_${crypto.randomBytes(16).toString("hex")}`;
}

export function connectorUrlFor(token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/mcp/${token}`;
}

/** Config del tenant (se crea deshabilitada con token al primer acceso). */
export async function getMcpConfig(companyId: string) {
  const config =
    (await prisma.mcpConfig.findUnique({ where: { companyId } })) ??
    (await prisma.mcpConfig.create({ data: { companyId, token: newMcpToken() } }));
  return { enabled: config.enabled, token: config.token, connectorUrl: connectorUrlFor(config.token) };
}

export async function updateMcpConfig(companyId: string, data: { enabled: boolean }) {
  await getMcpConfig(companyId); // asegura la fila
  const config = await prisma.mcpConfig.update({ where: { companyId }, data: { enabled: data.enabled } });
  return { enabled: config.enabled, token: config.token, connectorUrl: connectorUrlFor(config.token) };
}

/** Regenera el token (la URL anterior deja de funcionar al instante). */
export async function regenerateMcpToken(companyId: string) {
  await getMcpConfig(companyId);
  const config = await prisma.mcpConfig.update({ where: { companyId }, data: { token: newMcpToken() } });
  return { enabled: config.enabled, token: config.token, connectorUrl: connectorUrlFor(config.token) };
}

/** token → companyId (solo si el conector está habilitado). Null si no autoriza. */
export async function resolveMcpToken(token: string): Promise<string | null> {
  if (!token || !token.startsWith("mcp_")) return null;
  const config = await prisma.mcpConfig.findUnique({ where: { token }, select: { companyId: true, enabled: true } });
  return config?.enabled ? config.companyId : null;
}
