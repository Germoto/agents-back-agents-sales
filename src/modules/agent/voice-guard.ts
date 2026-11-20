/**
 * Guardia de las notas de voz del agente.
 *
 * La regla «cuándo» la escribe el dueño en lenguaje natural. Dejarle la decisión solo al
 * modelo no alcanza (en prod, 20-nov-2026, solo enviaba voz si el cliente la pedía): aquí
 * un revisor corto decide si el mensaje cumple la regla y, si cumple, el runtime exige
 * la nota de voz. Sin reglas de negocio: solo se aplica lo que configuró cada dueño.
 */

import { chatCompletion, type ChatMessage } from "../../lib/openai";
import type { TurnContext } from "./agent-tools";

const REVIEW_TIMEOUT_MS = 7_000;
const HISTORY_MESSAGES = 6;

function textOf(m: ChatMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "")).join(" ");
  return "";
}

/** Texto que ve el revisor: los últimos mensajes del chat, recortados. */
export function voiceReviewTranscript(history: ChatMessage[]): string {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-HISTORY_MESSAGES)
    .map((m) => `${m.role === "user" ? "Cliente" : "Negocio"}: ${textOf(m).replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .join("\n");
}

/** Lee el veredicto del revisor ({"cumple": true}); cualquier otra cosa = no. */
export function parseVoiceVerdict(raw: string | null | undefined): boolean {
  const m = (raw ?? "").match(/"?cumple"?\s*[:=]\s*"?(true|false|s[ií]|no)"?/i);
  return !!m && /^(true|s[ií])$/i.test(m[1]);
}

/**
 * ¿El último mensaje del cliente cumple la regla «cuándo» del dueño? Una consulta corta
 * al modelo del negocio. Si falla o tarda, responde false (el turno sigue normal).
 */
export async function voiceRuleApplies(ctx: TurnContext, history: ChatMessage[]): Promise<boolean> {
  const tool = ctx.config.agent.voiceTool;
  const { apiKey, model, baseUrl } = ctx.config.openai;
  if (!tool?.enabled || !tool.when || !apiKey) return false;
  const transcript = voiceReviewTranscript(history);
  if (!transcript) return false;
  try {
    const call = chatCompletion({
      apiKey,
      model,
      baseUrl,
      temperature: 0,
      maxTokens: 60,
      messages: [
        {
          role: "system",
          content:
            'Eres un revisor. El dueño de un negocio escribió una condición para que su vendedor responda con una NOTA DE VOZ en vez de texto. Lee el chat y decide si el ÚLTIMO mensaje del cliente cumple esa condición. Si la condición tiene varias partes unidas por «o», basta con que se cumpla una. Responde SOLO con un JSON: {"cumple": true} o {"cumple": false}.',
        },
        {
          role: "user",
          content:
            `Condición del dueño: ${tool.when}\n` +
            `¿El último mensaje del cliente fue un audio (nota de voz)?: ${ctx.lastInboundWasAudio ? "SÍ" : "no"}\n\n` +
            `Chat (del más antiguo al más reciente):\n${transcript}`,
        },
      ],
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), REVIEW_TIMEOUT_MS));
    const res = await Promise.race([call, timeout]);
    return parseVoiceVerdict(res?.content);
  } catch (err) {
    console.warn(`[agent] revisor de nota de voz falló convo=${ctx.conversationId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Nota previa al turno cuando la regla se cumple. */
export const VOICE_DUE_NOTE =
  "[NOTA DEL SISTEMA, no es un mensaje del cliente] Este mensaje del cliente CUMPLE la condición de nota de voz del negocio. Responde con una nota de voz: llama a enviar_nota_de_voz con tu respuesta, en tu estilo de siempre. Si antes necesitas otra herramienta (buscar, enviar algo), úsala primero. No menciones esta nota.";

/** Nota de reintento: el modelo contestó por texto aunque la regla se cumplía. */
export function voiceRetryNote(maxChars: number): string {
  return `[NOTA DEL SISTEMA, no es un mensaje del cliente] Ese texto NO se envió. Este turno se responde con nota de voz: llama AHORA a enviar_nota_de_voz diciendo eso mismo con tu estilo, en menos de ${maxChars} caracteres, sin links ni emojis y con las cifras en palabras. Después responde SIN_RESPUESTA, salvo que haya un dato que el cliente deba copiar (link, cuenta, código).`;
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** ¿El texto final repite lo que ya se dijo en la nota de voz? (más de la mitad de sus palabras). */
export function repeatsVoiceNote(finalText: string, transcript: string): boolean {
  const words = norm(finalText);
  if (words.length < 4) return false;
  const said = new Set(norm(transcript));
  const shared = words.filter((w) => said.has(w)).length;
  return shared / words.length >= 0.6;
}
