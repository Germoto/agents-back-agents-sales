/**
 * Contactos que llegan por USERNAME de WhatsApp (LID): SMS Tools antepone el
 * username al texto del mensaje — "[@RodrigoDj] Hola, quiero info…". Este
 * helper puro (O(1), regex anclado al inicio) extrae el username y devuelve el
 * texto limpio; se aplica UNA vez en handleInbound (interceptor único) para que
 * todo el pipeline (historial del agente, panel, transcripciones) vea el
 * mensaje sin el prefijo.
 */

const USERNAME_PREFIX = /^\s*\[@?([^[\]\n]{1,48})\]\s+/;

export function extractInboundUsername(text: string | null | undefined): {
  username: string | null;
  text: string;
} {
  const raw = text ?? "";
  const m = raw.match(USERNAME_PREFIX);
  if (!m) return { username: null, text: raw };
  const clean = raw.slice(m[0].length).trim();
  // "[algo]" sin texto después: probablemente NO es un prefijo de username.
  if (!clean) return { username: null, text: raw };
  const username = m[1].replace(/^@/, "").trim();
  return { username: username || null, text: clean };
}
