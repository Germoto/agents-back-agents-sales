/**
 * Texto «como se dice» para las notas de voz: ElevenLabs solo lee, así que unidades,
 * monedas, siglas y símbolos deben llegarle ya escritos como se pronuncian.
 *
 * Tres piezas: la regla general (va al prompt del agente y a «Probar voz»), la lista de
 * pronunciación de cada negocio (prompt + reemplazo en servidor) y la reescritura corta
 * que usa «Probar voz» para sonar igual que un chat real.
 */

import { chatCompletion } from "../../lib/openai";

/** Regla general de formato hablado. Los ejemplos son guía, no lista cerrada. */
export const SPOKEN_RULE =
  "Escribe TODO como se pronuncia, nada abreviado: unidades, monedas, porcentajes, horas, siglas y símbolos van en palabras, como los diría una persona (por ejemplo «150 GB» es «ciento cincuenta gigas», «S/ 50» es «cincuenta soles», «20%» es «veinte por ciento», «24/7» es «veinticuatro siete», «8:30 pm» es «ocho y media de la noche»).";

export type Pronunciation = { from: string; to: string };

/** Lista del dueño, una regla por línea: «GB = gigas». Las líneas mal escritas se ignoran. */
export function parsePronunciations(raw: string | null | undefined): Pronunciation[] {
  const out: Pronunciation[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s*(?:=>|->|=|→)\s*(.+?)\s*$/);
    if (!m) continue;
    const from = m[1].trim();
    const to = m[2].trim();
    if (from && to && from.length <= 40 && to.length <= 80) out.push({ from, to });
  }
  // Primero las más largas, para que «GB RAM» gane sobre «GB».
  return out.sort((a, b) => b.from.length - a.from.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reemplaza cada término de la lista (palabra completa, sin distinguir mayúsculas). */
export function applyPronunciations(text: string, raw: string | null | undefined): string {
  let out = text;
  for (const { from, to } of parsePronunciations(raw)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{N}])`, "giu"), to);
  }
  return out;
}

/** Texto de la lista para el prompt («GB» se dice «gigas»; …). "" si no hay. */
export function pronunciationsLine(raw: string | null | undefined): string {
  const list = parsePronunciations(raw);
  return list.length ? list.map((p) => `«${p.from}» se dice «${p.to}»`).join("; ") : "";
}

const REWRITE_TIMEOUT_MS = 10_000;

/**
 * Reescribe un texto para ser dicho (solo «Probar voz»: en los chats lo escribe el agente).
 * Devuelve null si no hay IA configurada, falla o tarda: se usa el texto tal cual.
 */
export async function rewriteForSpeech(input: {
  ai: { apiKey?: string | null; model: string; baseUrl?: string | null };
  text: string;
  speechStyle?: string;
  pronunciations?: string;
  allowTags: boolean;
}): Promise<string | null> {
  const { apiKey, model, baseUrl } = input.ai;
  if (!apiKey) return null;
  const style = (input.speechStyle ?? "").trim();
  const said = pronunciationsLine(input.pronunciations);
  try {
    const call = chatCompletion({
      apiKey,
      model,
      baseUrl: baseUrl ?? undefined,
      temperature: 0.3,
      maxTokens: 500,
      messages: [
        {
          role: "system",
          content:
            "Reescribes un texto para que una persona lo DIGA en una nota de voz de WhatsApp. Conserva el sentido y todos los datos; no agregues información ni saludos. " +
            SPOKEN_RULE +
            " Frases cortas como al hablar, pausas con comas y puntos suspensivos, sin emojis, listas, formato ni links." +
            (style ? ` Así habla quien manda el audio: «${style}».` : "") +
            (said ? ` Pronunciación obligatoria: ${said}.` : "") +
            (input.allowTags ? " Puedes poner como mucho una o dos marcas de entonación en inglés entre corchetes, como [laughs] o [sighs]." : " No uses corchetes ni acotaciones.") +
            " Responde SOLO con el texto reescrito, sin comillas ni explicaciones.",
        },
        { role: "user", content: input.text },
      ],
    });
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), REWRITE_TIMEOUT_MS));
    const res = await Promise.race([call, timeout]);
    const out = (res?.content ?? "").trim().replace(/^["«“]+|["»”]+$/g, "").trim();
    return out.length >= 3 ? out : null;
  } catch (err) {
    console.warn("[voice] reescritura para «Probar voz» falló:", err instanceof Error ? err.message : err);
    return null;
  }
}
