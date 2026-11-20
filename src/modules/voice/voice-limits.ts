/** Constantes puras de las notas de voz del agente (sin dependencias, las usa el esquema). */

/** Modelos de voz admitidos (el primero es el de fábrica; v4 y v3 son los expresivos). */
export const VOICE_MODELS = ["eleven_multilingual_v2", "eleven_v4", "eleven_v3", "eleven_turbo_v2_5", "eleven_flash_v2_5"] as const;
export type VoiceModel = (typeof VOICE_MODELS)[number];

/** Modelos que interpretan marcas entre corchetes ([laughs], [sighs]…); los demás las leerían en voz alta. */
const VOICE_TAG_MODELS: readonly string[] = ["eleven_v4", "eleven_v3"];
export function voiceModelHasTags(model: string): boolean {
  return VOICE_TAG_MODELS.includes(model);
}

export const VOICE_LIMITS = {
  speed: { min: 0.7, max: 1.2, def: 1 },
  stability: { min: 0, max: 1, def: 0.5 },
  similarity: { min: 0, max: 1, def: 0.75 },
  /** Expresividad («style» en ElevenLabs). 0 = como venía funcionando. */
  style: { min: 0, max: 1, def: 0 },
  /** «Cómo hablas»: forma de hablar del dueño, en sus palabras. */
  speechStyleMax: 600,
  /** «Pronunciación»: una regla por línea, «GB = gigas». */
  pronunciationsMax: 400,
  maxChars: { min: 100, max: 800, def: 400 },
  perDay: { min: 1, max: 2000, def: 100 },
} as const;

/** Marca en rawPayload de una nota de voz generada (sirve para el tope del día). */
export const VOICE_SOURCE = "voice";
