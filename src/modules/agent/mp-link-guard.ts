/**
 * Guardia del link de pago de Mercado Pago. Dos detecciones sobre el texto final del
 * agente: PROMETE el link («te paso el link 👇») sin que la herramienta lo haya
 * enviado en el turno, o trae un link de pago ESCRITO A MANO (copiado de un mensaje
 * anterior o inventado). Funciones puras: el runtime decide qué hacer con el resultado.
 */

import type { ConversationState } from "./conversation.service";

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const LINK_RE = /\b(link|enlace)s?\b/;
const URL_RE = /https?:\/\/|www\.|mpago\.la/;
const ARROW_RE = /👇|⬇/u;
/** Envío en presente o futuro (en primera persona) o señal de «aquí está». */
const SEND_RE =
  /\b(te|le|les)\s+(lo\s+)?(paso|mando|envio|dejo|comparto|adjunto|pasare|mandare|enviare|dejare|compartire)\b|\b(voy|vamos)\s+a\s+(pasar|mandar|enviar|dejar|compartir)(te|le|les|telo|selo)?\b|\b(aqui|ahi)\s+(va|tienes|esta|te\s+(va|dejo|paso|mando|envio))\b|\b(este|el\s+siguiente)\s+(link|enlace)\b|\ba\s+continuacion\b/;
/** Referencia a un link que ya se envió antes: no es una promesa nueva. */
const PAST_RE =
  /\b(arriba|anterior|anteriormente|el\s+mismo\s+(link|enlace)|ya\s+(te|le|les)\s+(lo\s+)?(envie|mande|pase|deje|comparti)|(te|le|les)\s+(lo\s+)?(envie|mande|pase|deje|comparti)|(ya\s+)?(esta|lo\s+tienes)\s+en\s+(el|este)\s+chat|sigue\s+(activo|vigente|disponible))\b/;
/** Ofrecimiento condicionado («si quieres te paso el link»): todavía no lo promete. */
const OFFER_RE =
  /\b(si\s+(quieres|prefieres|deseas|gustas|te\s+parece|necesitas|lo\s+necesitas)|cuando\s+(quieras|gustes|puedas)|avisame|me\s+avisas|dime\s+(si|y)|puedo\s+(pasarte|enviarte|mandarte|dejarte))\b/;
const PAY_RE =
  /\b(pago|pagos|paga|pagar|pagas|pagues|pagarlo|pagarla|tarjeta|mercado\s*pago|credito|debito|cobro|transferencia|banco|bcp|bbva|interbank|scotiabank)\b/;
/** Link calificado como otra cosa («link de la tienda», «enlace de acceso»). */
const QUALIFIED_OTHER_RE =
  /\b(link|enlace)s?\s+(de|del|al|a|para)\s+(la\s+|el\s+|los\s+|las\s+|tu\s+|su\s+)?(tienda|drive|carpeta|reunion|meet|zoom|acceso|descarga|catalogo|grupo|canal|calendario|agenda|cita|curso|clase|video|formulario|registro|web|pagina|sitio|material|pack|producto|pedido|subida)\b/;
const OTHER_RE =
  /\b(tienda|drive|carpeta|reunion|meet|zoom|acceso|accesos|descarga|descargar|catalogo|grupo|canal|calendario|agendar|cita|formulario|registro|pagina|sitio|subir)\b/;

/** ¿El chat está en contexto de cobro? (una promesa sin palabra de pago solo cuenta ahí). */
function inPaymentContext(state: ConversationState): boolean {
  const status = state.status ?? "";
  if (status === "PAGADO" || status === "ENTREGADO" || status === "ASESOR_HUMANO") return false;
  return status === "ESPERANDO_PAGO" || Boolean(state.mpLinkSentAt) || Boolean(state.lastPaymentPromptAt);
}

/**
 * ¿El texto promete enviar AHORA el link de pago? Se evalúa oración por oración:
 * tiene que hablar de link/enlace con una señal de envío en presente o futuro, sin
 * referirse a un link anterior, a otro tipo de link ni ser una pregunta u ofrecimiento.
 */
export function promisesPaymentLink(text: string | null | undefined, state: ConversationState): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  const full = norm(raw);
  // Si el texto ya trae una URL, no hay promesa pendiente que cumplir.
  if (URL_RE.test(full)) return false;
  const sentences = full.split(/(?<=[.!?\n])/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (!LINK_RE.test(s)) continue;
    if (/[¿?]/.test(s)) continue;
    if (PAST_RE.test(s)) continue;
    if (QUALIFIED_OTHER_RE.test(s)) continue;
    const arrow = ARROW_RE.test(s);
    if (!arrow && !SEND_RE.test(s)) continue;
    if (!arrow && OFFER_RE.test(s)) continue;
    if (PAY_RE.test(s)) return true;
    if (OTHER_RE.test(s)) continue;
    // Sin palabra de pago en la oración: cuenta si el resto del texto habla de pagar
    // («puedes pagar con tarjeta. Te mando el link.») o si el chat está en cobro.
    if (PAY_RE.test(full) && !OTHER_RE.test(full)) return true;
    if (inPaymentContext(state)) return true;
  }
  return false;
}

/**
 * Link de pago que genera el sistema: preferencia de Checkout Pro
 * (…mercadopago.com.pe/checkout/v1/redirect?pref_id=…) o el link de muestra del
 * simulador. Los links fijos del dueño (mpago.la/xxxx, link.mercadopago…) no entran.
 */
const MP_PAY_LINK_SRC =
  String.raw`(?:https?:\/\/)?(?:[\w-]+\.)*mercadopago\.[a-z.]{2,10}\/[^\s<>"'*\])]*(?:pref[_-]?id=|checkout\/)[^\s<>"'*\])]*` +
  String.raw`|(?:https?:\/\/)?mpago\.la\/ejemplo(?:\s*\(link de muestra[^)]*\))?`;
const mpPayLinkRe = () => new RegExp(MP_PAY_LINK_SRC, "gi");

/** Lo que ve el agente en su historial en lugar de la URL de un link de pago ya enviado. */
export const MP_LINK_PLACEHOLDER = "[link de pago ya enviado al cliente]";
const PLACEHOLDER_RE = /\[\s*link de pago[^\]\n]*\]/i;

/** Un link que el dueño escribió en su configuración (prompt, productos) no se toca. */
const isKnown = (url: string, knownText?: string | null) =>
  Boolean(knownText && knownText.includes(url.replace(/[.,;:!?]+$/, "")));

/**
 * Oculta los links de pago de Mercado Pago de un mensaje del historial: el agente
 * sabe que el link se envió, pero no ve la URL y no puede copiarla (pasó en prod:
 * pegó a mano el link viejo en vez de llamar a la herramienta de cobro).
 */
export function maskMpLinks(text: string, knownText?: string | null): string {
  if (!text) return text;
  return text.replace(mpPayLinkRe(), (url) => (isKnown(url, knownText) ? url : MP_LINK_PLACEHOLDER));
}

/**
 * ¿El texto trae un link de pago de Mercado Pago escrito por el modelo? Cuenta la URL
 * de una preferencia y también el marcador del historial copiado tal cual.
 */
export function pastesMpLink(text: string | null | undefined, knownText?: string | null): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  if (PLACEHOLDER_RE.test(raw)) return true;
  return (raw.match(mpPayLinkRe()) ?? []).some((url) => !isKnown(url, knownText));
}
