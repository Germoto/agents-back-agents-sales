/**
 * Enlaces al panel web del negocio (FRONTEND_URL) para los avisos al dueño.
 * Si FRONTEND_URL no está configurado, los avisos salen sin link (como antes).
 */
import { env } from "../config/env";

function panelBase(): string | null {
  const base = (env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  return base || null;
}

/** URL del chat en el panel (Conversaciones abre el chat por `?id=`). */
export function panelConversationUrl(conversationId: string | null | undefined): string | null {
  const base = panelBase();
  if (!base || !conversationId) return null;
  return `${base}/conversaciones?id=${encodeURIComponent(conversationId)}`;
}

/** Línea lista para pegar al final de un aviso por WhatsApp ("" si no hay link). */
export function chatLinkLine(conversationId: string | null | undefined): string {
  const url = panelConversationUrl(conversationId);
  return url ? `\n👉 Abrir chat: ${url}` : "";
}
