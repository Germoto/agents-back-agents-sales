/**
 * Loop del agente: arma system prompt + historial, llama a OpenAI con
 * tool-calling y ejecuta herramientas hasta que el modelo produce el texto
 * final para el cliente. Reemplaza el mega-nodo de n8n.
 */

import { chatCompletion, type ChatMessage } from "../../lib/openai";
import { buildSystemPrompt } from "./agent-prompt";
import { buildKnowledgeHint, trailingUserText } from "./faq-match";
import { toolDefinitionsFor, executeTool, emailDeliveryAvailable, shippingOf, postponeAvailable, reportPaymentForReview, type TurnContext } from "./agent-tools";
import { currentOrderFor } from "../orders/order-money";
import { agentStoreLinks } from "../storefront/storefront-public-url";
import type { PromptExtras } from "./agent-prompt";
import { summarizeCart } from "./cart.service";
import { mpChatOn, ownerReviewsPayments } from "./payment-methods";
import { promisesPaymentLink, pastesMpLink, maskMpLinks } from "./mp-link-guard";
import { promisesFollowupDate, parsePromisedDate } from "./postpone-guard";
import { normalizeSmartFollowup, activePostpone, formatPostponeDate } from "../scheduler/smart-followup";
import { zonedParts } from "../scheduler/quiet-hours";
import { findUpcomingBookingForCustomer } from "../bookings/bookings.service";
import { formatSlotLabel } from "../bookings/availability.service";
import { extractEmail } from "../../lib/email";
import { prisma } from "../../lib/prisma";
import { voiceRuleApplies, VOICE_DUE_NOTE, voiceRetryNote } from "./voice-guard";
import { voiceToolAvailable } from "./agent-tools";

const MAX_ITERATIONS = 6;
/** Frases típicas de "no me escribas más" (sin acentos obligatorios). */
const OPT_OUT_RE =
  /\b((ya )?no (me |nos |m)?(escrib|molest|insist|mand|envi)|dej(a|e|en|ar) de (escribir|molestar|insistir|mandar|enviar)|no (me )?(vuelv|vuelva|vuelvan|volver) a escribir|b[oó]rr(a|e|en)(me|nos)|elim[ií]n(a|e|en)(me|nos)|no (me )?interesa[,.! ]+(no|ya no|deja|dejen)|no quiero (que (me )?escrib|recibir|m[aá]s mensajes)|s[aá](c|q)(a|ame|anos|uenme|enme|uennos) de (la|su|tu) lista|^\s*stop\s*$)/i;
const FALLBACK_TEXT =
  "Disculpa, tuve un problema para procesar tu mensaje. ¿Me lo repites o me dices qué producto te interesa?";

const TURN_LOG_MAX_TURNS = 10;
const TURN_LOG_MAX_TOOLS = 12;

/** Anota en el registro del turno una herramienta ejecutada y si devolvió error. */
function logTool(ctx: TurnContext, name: string, result: string, sistema = false): void {
  let ok = true;
  let error: string | undefined;
  try {
    const r = JSON.parse(result) as { ok?: unknown; error?: unknown } | null;
    if (r && typeof r === "object" && (r.ok === false || (r.error && r.ok !== true))) {
      ok = false;
      error = typeof r.error === "string" ? r.error.slice(0, 160) : undefined;
    }
  } catch {
    // Resultado que no es JSON: se cuenta como ejecutada sin error.
  }
  (ctx.turnLog ??= []).push({ tool: name, ok, ...(error ? { error } : {}), ...(sistema ? { sistema: true } : {}) });
}

/**
 * Pasa el registro del turno al estado de la conversación (últimos turnos, con tope).
 * Se llama al cerrar el turno, antes de guardar el estado. Un turno sin herramientas
 * ni guardias no se anota.
 */
export function recordTurnLog(ctx: TurnContext, now = new Date()): void {
  const tools = (ctx.turnLog ?? []).slice(0, TURN_LOG_MAX_TOOLS);
  const guards = ctx.guardEvents ?? [];
  if (!tools.length && !guards.length) return;
  const prev = Array.isArray(ctx.state.turnLog) ? ctx.state.turnLog : [];
  ctx.state.turnLog = [...prev, { at: now.toISOString(), tools, ...(guards.length ? { guards } : {}) }].slice(-TURN_LOG_MAX_TURNS);
}

const POSTPONE_GUARD_NOTE =
  "[Nota del sistema, no la escribió el cliente] Tu mensaje anterior NO se envió: promete escribirle al cliente en una fecha, pero no llamaste a posponer_seguimiento, así que ese día no saldría ningún mensaje y los recordatorios automáticos le llegarían antes. Llama AHORA a posponer_seguimiento con `fecha` (AAAA-MM-DD), `hora` (HH:mm) y `mensaje` (el texto que recibirá ese día) y después confírmale el momento en una línea. Si en realidad no corresponde escribirle ese día, responde sin prometer una fecha.";

/** Herramientas que ya dejan programado un contacto: con ellas la promesa de fecha está cubierta. */
const SCHEDULING_TOOLS = new Set(["agendar_recordatorio", "agendar_servicio", "reprogramar_cita"]);

const tzOf = (ctx: TurnContext) => (ctx.config.business as { timezone?: string }).timezone ?? "America/Lima";

/** ¿La guardia de la fecha prometida tiene algo que revisar en este turno? */
function postponeGuardApplies(ctx: TurnContext): boolean {
  if (ctx.postponedThisTurn || ctx.handoffThisTurn) return false;
  return !(ctx.toolsCalled ?? []).some((t) => SCHEDULING_TOOLS.has(t));
}

/** El texto solo repite una pausa que ya está programada para ese mismo día. */
function restatesActivePostpone(ctx: TurnContext, text: string, customerText: string): boolean {
  const active = activePostpone(ctx.state);
  if (!active) return false;
  const tz = tzOf(ctx);
  const parsed = parsePromisedDate(text, { now: new Date(), tz, customerText });
  if (!parsed?.fecha) return true;
  const p = zonedParts(active.until, tz);
  return parsed.fecha === `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Red de seguridad de la fecha prometida: el modelo prometió escribir en una fecha y no
 * llamó a posponer_seguimiento ni después de la nota. El sistema lee el día y la hora
 * del texto y programa el mensaje de respaldo del negocio con la misma herramienta. Si
 * no logra leer la fecha, no programa nada y deja una nota interna en el chat.
 */
async function systemPostpone(ctx: TurnContext, promise: string, customerText: string): Promise<void> {
  const smart = normalizeSmartFollowup(ctx.config.agent.followupConfig);
  const parsed = parsePromisedDate(promise, { now: new Date(), tz: tzOf(ctx), customerText });
  if (parsed) {
    const result = await executeTool("posponer_seguimiento", { ...parsed, mensaje: smart.postpone.fallbackMessage }, ctx).catch((err) =>
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "tool error" }),
    );
    logTool(ctx, "posponer_seguimiento", result, true);
    const active = ctx.postponedThisTurn ? activePostpone(ctx.state) : null;
    if (active) {
      (ctx.toolsCalled ??= []).push("posponer_seguimiento");
      const when = formatPostponeDate(active.until, tzOf(ctx));
      (ctx.guardEvents ??= []).push(`fecha prometida sin posponer: el sistema programó el mensaje de respaldo para el ${when}`);
      console.warn(`[agent] fecha prometida sin herramienta (guardia: programado por el sistema para ${when}) convo=${ctx.conversationId}: ${promise.slice(0, 160)}`);
      return;
    }
  }
  (ctx.guardEvents ??= []).push("fecha prometida sin posponer: el sistema no pudo leer la fecha y no programó nada");
  (ctx.systemNotes ??= []).push(
    `🗓️ El agente le prometió al cliente escribirle en una fecha («${promise.slice(0, 140)}») y no la programó. El sistema no pudo leer esa fecha, así que no quedó ningún mensaje programado: revisa este chat.`,
  );
  console.warn(`[agent] fecha prometida sin herramienta (guardia: fecha ilegible, sin programar) convo=${ctx.conversationId}: ${promise.slice(0, 160)}`);
}

/** Respuesta literal del modelo cuando no queda nada por contestar (ver TRAILING_ASSISTANT_NOTE). */
export const NO_REPLY_TOKEN = "SIN_RESPUESTA";
/**
 * Nota en rol usuario que cierra un historial que termina en mensaje del bot. Pasa
 * cuando el cliente escribe MIENTRAS el bot responde: la respuesta se graba después
 * del mensaje nuevo y el siguiente turno ve el historial terminando en el bot. Claude
 * 5.x rechaza esa petición ("does not support assistant message prefill… must end
 * with a user message"); OpenAI la toleraba. La nota deja claro qué responder.
 */
const TRAILING_ASSISTANT_NOTE =
  "[Sistema: el cliente escribió sus últimos mensajes MIENTRAS respondías, así que tu última respuesta no los tuvo en cuenta. " +
  `Responde ahora lo que haya quedado sin atender. Si tu última respuesta ya lo cubre todo, contesta exactamente ${NO_REPLY_TOKEN} (sin nada más).]`;

/** Textos reales que el bot envió (sin los marcadores "[se envió una imagen…]"), del más reciente al más antiguo. */
function recentBotTexts(history: ChatMessage[], max: number): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < max; i--) {
    const m = history[i];
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    const t = m.content.trim();
    if (!t || /^\[se envió [^\]]*\]$/i.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** Texto comparable: minúsculas, sin tildes, sin emojis ni signos, espacios colapsados. */
function comparableText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿El texto es igual a uno de los últimos mensajes que el bot ya envió? Solo se usa en
 * el turno que corre porque el cliente escribió MIENTRAS el bot respondía (pasó en prod:
 * tras la ficha, el segundo turno repitió el mismo cierre «¿Deseas para Lima o para
 * provincia?»). Igualdad del texto completo: una respuesta que agrega algo nuevo sí sale.
 */
export function repeatsRecentBotText(text: string, history: ChatMessage[]): boolean {
  const mine = comparableText(text);
  if (!mine) return false;
  return recentBotTexts(history, 6).some((t) => comparableText(t) === mine);
}

/**
 * Nota del turno que corre porque el cliente escribió mientras el bot respondía. Cita el
 * último texto del bot para que el modelo no lo repita; sin texto (solo multimedia) queda
 * la nota de siempre.
 */
export function trailingAssistantNote(history: ChatMessage[]): string {
  const last = recentBotTexts(history, 1)[0];
  if (!last) return TRAILING_ASSISTANT_NOTE;
  const quoted = last.length > 300 ? `${last.slice(0, 300)}…` : last;
  return (
    "[Sistema: el cliente escribió sus últimos mensajes MIENTRAS respondías, así que tu última respuesta no los tuvo en cuenta. " +
    `Tu último mensaje fue: «${quoted}». NO lo repitas ni lo digas con otras palabras. ` +
    `Responde solo si el cliente preguntó algo que tus mensajes anteriores no cubren; si ya está cubierto, contesta exactamente ${NO_REPLY_TOKEN} (sin nada más).]`
  );
}

const REPEATED_CLOSING_EVENT = "cierre repetido descartado: el cliente escribió durante la respuesta";

/**
 * ¿El texto es un comentario INTERNO del modelo y no un mensaje para el cliente?
 * (notas entre corchetes, auto-correcciones, narración del tipo "el cliente envió…").
 * Nunca deben llegar al cliente.
 */
const INTERNAL_NOTE_RE =
  /(respuesta vac[ií]a|mi respuesta anterior|respuesta anterior (tuvo|ten[ií]a|fue)|el cliente (solo |s[oó]lo )?(envi[oó]|escribi[oó]|mand[oó])|nota interna|texto (final )?vac[ií]o|dej(o|ar[eé]|é) (el |mi )?(texto|mensaje|respuesta)( final)? (vac[ií]|en blanco)|el sistema ya (se )?le (respond|ped|pid|envi|avis|mand)|ya (le (respond[ií]|ped[ií]|envi[eé]|avis[eé]|mand[eé])|se le (respondi[oó]|pidi[oó]|envi[oó]|avis[oó]|mand[oó])) (el [a-záéíóú ]{0,25})?al cliente|no hay nada nuevo que|lo [uú]ltimo que me dijiste fue|\(sin respuesta\)|\bSIN_RESPUESTA\b.+|.+\bSIN_RESPUESTA\b)/i;
export function isInternalNote(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  // Todo el mensaje es UNA sola nota entre corchetes: "[Respuesta vacía: …]".
  if (/^\[[^\]]*\]$/.test(t) && t.length > 12) return true;
  return INTERNAL_NOTE_RE.test(t);
}

const TOOL_WORD_RE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gi;

/**
 * Nombres internos de herramientas que aparecen en un texto para el cliente (pasó en
 * prod: «debo registrar todo junto con registrar_pedido_carrito»). Solo cuentan las
 * palabras con guion bajo que son EXACTAMENTE una herramienta del agente.
 */
export function leakedToolNames(text: string | null | undefined, toolNames: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const word of (text ?? "").match(TOOL_WORD_RE) ?? []) {
    const name = word.toLowerCase();
    if (toolNames.has(name)) found.add(name);
  }
  return [...found];
}

/** Quita las frases que nombran una herramienta; el resto del mensaje se conserva. */
export function stripToolNameSentences(text: string, toolNames: ReadonlySet<string>): string {
  // Con captura, split devuelve frase, separador, frase, separador…
  const parts = text.split(/((?<=[.!?…])\s+|\n+)/);
  let out = "";
  for (let i = 0; i < parts.length; i += 2) {
    if (leakedToolNames(parts[i], toolNames).length) continue;
    out += parts[i] + (parts[i + 1] ?? "");
  }
  return out.trim();
}

function toolNameRetryNote(names: string[]): string {
  return (
    `Tu respuesta anterior NO se envió al cliente: nombraba una herramienta interna (${names.join(", ")}). ` +
    "El cliente no sabe de herramientas ni de errores internos, y no hay que pedirle que confirme por ellos. " +
    `Si corresponde usar una herramienta, llámala ahora; si no, escribe SOLO el mensaje que verá el cliente, sin nombres internos, o exactamente ${NO_REPLY_TOKEN} si no corresponde decir nada.`
  );
}

const INTERNAL_NOTE_RETRY =
  `Tu respuesta anterior era un comentario interno y NO se envió al cliente. Escribe SOLO el mensaje que verá el cliente (natural, sin corchetes ni comentarios sobre la conversación), o exactamente ${NO_REPLY_TOKEN} si no corresponde decir nada.`;

/**
 * Nota en rol usuario tras la guardia del link de pago (ver el bucle de runAgentTurn):
 * el texto que prometía el link, o que lo traía escrito a mano, no se envió y el
 * modelo reescribe su cierre sabiendo si el link salió o no.
 */
function mpLinkGuardNote(sent: boolean, toolResult: string, kind: "promise" | "pasted" = "promise"): string {
  const pasted = kind === "pasted";
  const head = pasted
    ? "[Nota del sistema, no la escribió el cliente] Tu respuesta anterior traía un link de pago escrito por ti (copiado de un mensaje anterior o inventado), así que ese texto NO se envió al cliente: un link de pago solo vale cuando lo envía la herramienta enviar_metodos_pago. "
    : "[Nota del sistema, no la escribió el cliente] Tu respuesta anterior anunciaba el link de pago pero no llamaste a la herramienta, así que ese texto NO se envió al cliente. ";
  if (sent) {
    return (
      head +
      (pasted
        ? "El cliente ya tiene en este turno el mensaje del sistema con el monto y un link de pago NUEVO de Mercado Pago. "
        : "El sistema acaba de enviarle el mensaje con el monto y el link de pago de Mercado Pago. ") +
      `Escribe SOLO lo que falte decirle (sin repetir el monto ni el link${pasted ? ", sin ninguna URL de pago" : ""} y sin anunciar que se lo vas a pasar), o exactamente ${NO_REPLY_TOKEN} si no hace falta agregar nada.`
    );
  }
  let reason = toolResult;
  try {
    const parsed = JSON.parse(toolResult) as { error?: string };
    if (parsed?.error) reason = parsed.error;
  } catch {
    // resultado no JSON: se pasa tal cual
  }
  return (
    head +
    `El sistema intentó enviar el link y NO se pudo: ${reason.slice(0, 700)} ` +
    (pasted
      ? "Escribe de nuevo tu mensaje al cliente SIN ningún link de pago y sin prometerlo."
      : "Escribe de nuevo tu mensaje al cliente SIN prometer ni anunciar el link.")
  );
}

/** Texto final del modelo → lo que se envía ("" si contestó NO_REPLY_TOKEN). */
function finalReply(text: string | null | undefined): string {
  const t = (text ?? "").trim();
  // Tolera formato alrededor del token (*SIN_RESPUESTA*, "SIN_RESPUESTA.", etc.).
  return t === NO_REPLY_TOKEN || t.replace(/[*`"'.\[\]()]/g, "").trim() === NO_REPLY_TOKEN ? "" : t;
}

/**
 * Ejecuta un turno completo. `history` debe incluir ya el último mensaje del
 * cliente (se lee de la BD después de persistirlo). Devuelve el texto final;
 * los adjuntos y acciones quedan acumulados en ctx.outbox / ctx.reminders.
 */
export async function runAgentTurn(ctx: TurnContext, history: ChatMessage[]): Promise<string> {
  // En modo FLOW buildBotConfig no exige apiKey; el agente IA sí la necesita.
  const apiKey = ctx.config.openai.apiKey;
  if (!apiKey) throw new Error("Falta openaiApiKey para esta empresa");

  // Rubros de CARRITO: inyectar el estado REAL del carrito en el prompt de CADA
  // turno. El historial no incluye los tool_calls de turnos anteriores, así que
  // sin esto el modelo "recuerda" su propia narración (re-agrega ítems, inventa
  // totales) en vez del carrito verdadero.
  const vertical = (ctx.config.business as { vertical?: string }).vertical;
  if (vertical === "RESTAURANT" || vertical === "PHYSICAL_GOODS") {
    try {
      const cart = await summarizeCart(ctx.companyId, ctx.customerId);
      ctx.state.cartText = cart.items.length
        ? cart.items
            .map(
              (it) =>
                `${it.quantity}x ${it.name}${it.modifiers.length ? ` (${it.modifiers.map((m) => m.option).join(", ")})` : ""} — ${cart.symbol} ${(it.unitPrice * it.quantity).toFixed(2)}`,
            )
            .join(" | ") + ` | TOTAL ${cart.totalText}`
        : "vacío";
    } catch {
      ctx.state.cartText = null;
    }
  }

  // Rubros con AGENDA: la cita vigente del cliente en el prompt de CADA turno.
  // Sin esto el modelo no sabe que ya tiene cita y "agenda" otra en vez de moverla.
  let upcomingBooking: { code: string | null; service: string; when: string; status: string } | null = null;
  if (vertical === "SERVICE" || vertical === "REAL_ESTATE") {
    try {
      const b = await findUpcomingBookingForCustomer(ctx.companyId, ctx.customerId);
      if (b) {
        const tz = (ctx.config.business as { timezone?: string }).timezone ?? "America/Lima";
        upcomingBooking = {
          code: b.bookingCode ?? null,
          service: b.product?.name ?? "cita",
          when: b.startsAt ? formatSlotLabel(b.startsAt, tz) : b.requestedText ? `"${b.requestedText}" (sin hora fijada aún)` : "sin hora fijada aún",
          status: b.status,
        };
      }
    } catch {
      upcomingBooking = null;
    }
  }

  // «Envíos»: el pedido vigente del cliente en el prompt de CADA turno, para que el
  // agente responda por su estado y cobre el saldo sin registrar otro pedido.
  let currentOrder: PromptExtras["currentOrder"] = null;
  if (shippingOf(ctx.config)) {
    const sim = ctx.state.simOrder;
    if (ctx.simulate) {
      if (sim) {
        currentOrder = {
          code: sim.orderCode,
          status: sim.status,
          total: sim.total,
          paid: sim.paid,
          balance: Math.max(0, sim.total - sim.paid),
          deliveryType: sim.deliveryType,
          courier: sim.courier,
          agencyName: sim.agencyName,
          agencyAddress: sim.agencyAddress,
        };
      }
    } else {
      try {
        const o = await currentOrderFor(ctx.companyId, ctx.customerId);
        if (o) {
          currentOrder = {
            code: o.orderCode,
            status: o.status,
            total: o.money.total,
            paid: o.money.paid,
            balance: o.money.balance,
            deliveryType: o.deliveryType,
            courier: o.courier,
            agencyName: o.agencyName,
            agencyAddress: o.agencyAddress,
            trackingCode: o.trackingCode,
            pickupKey: o.pickupKey,
            source: o.source,
          };
        }
      } catch {
        currentOrder = null;
      }
    }
  }

  // Tienda web de productos físicos: sus enlaces viajan al prompt solo si el negocio
  // encendió «El agente comparte la tienda» (apagado por defecto).
  let storeLinks: PromptExtras["storeLinks"] = null;
  if (vertical === "PHYSICAL_GOODS") {
    storeLinks = await agentStoreLinks(ctx.companyId).catch(() => null);
  }

  const systemPrompt = buildSystemPrompt(ctx.config, ctx.state, {
    flowVars: ctx.customerFlowVars ?? ((ctx.state.flow as { variables?: Record<string, string> } | undefined)?.variables ?? null),
    flowNote: (ctx.state.flow as { aiTakeover?: { note?: string } } | undefined)?.aiTakeover?.note ?? null,
    upcomingBooking,
    currentOrder,
    storeLinks,
    lastInboundWasAudio: ctx.lastInboundWasAudio,
  });
  // Con Mercado Pago en el chat, el modelo no ve la URL de los links de pago ya
  // enviados (queda un marcador): así no puede copiar un link viejo en vez de llamar a
  // la herramienta de cobro. El cliente y el panel siguen viendo el mensaje completo.
  const mpGuardOn = mpChatOn(ctx.config.payment);
  const shownHistory = mpGuardOn
    ? history.map((m) => (typeof m.content === "string" ? { ...m, content: maskMpLinks(m.content, systemPrompt) } : m))
    : history;
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...shownHistory];

  // FAQ determinística: si la consulta coincide claramente con una FAQ/objeción
  // configurada, se inyecta la respuesta al FINAL (recency) con instrucción de
  // usarla. No puede depender solo del modelo (las reglas de herramientas le
  // ganaban a la FAQ y enviaba archivos de otro tema como si fueran lo pedido).
  const inboundText = trailingUserText(history);
  if (inboundText && !inboundText.includes("[el cliente envió una imagen")) {
    const hint = buildKnowledgeHint(ctx.config.products, ctx.state.selectedProductId, inboundText);
    if (hint) {
      messages.push({ role: "system", content: hint });
      console.log(`[agent] FAQ determinística inyectada convo=${ctx.conversationId}`);
    }
  }

  // Opt-out determinista (red de seguridad): si el texto parece pedir que no le
  // escriban más, se recuerda al modelo la regla NO_CONTACTAR. El modelo decide
  // (evita falsos positivos tipo "no me escribas por ahora, te aviso").
  if (inboundText && OPT_OUT_RE.test(inboundText)) {
    messages.push({
      role: "system",
      content:
        "El cliente parece pedir que NO le escriban más. Si es así, respóndele UNA línea breve y respetuosa (sin vender ni preguntar) y llama derivar_humano con motivo NO_CONTACTAR en este mismo turno. Si en realidad solo pospone ('ahora no', 'luego te aviso'), sigue normal.",
    });
    console.log(`[agent] posible opt-out detectado convo=${ctx.conversationId}`);
  }

  // Validación determinista: si la visión ya leyó un CÓDIGO de seguridad, la
  // validación no puede depender de que el modelo decida llamar la herramienta
  // (pasó en prod: comprobante perfecto en el estado y el modelo respondió un
  // genérico sin validar). Se fuerza validar_pago en la primera iteración; el
  // resto del turno sigue normal con el resultado del tool.
  // «La reviso yo»: la captura no se valida ni pasa por el modelo. Se responde al
  // cliente, se avisa al dueño y el turno termina aquí (el cierre del turno pausa el bot).
  if (shouldReportReceipt(ctx)) {
    console.log(`[agent] pago reportado al dueño (revisión manual) convo=${ctx.conversationId}`);
    await reportPaymentForReview(ctx);
    return "";
  }
  const forceValidation = shouldForceValidation(ctx);
  if (forceValidation) {
    ctx.state.receiptAutoHandledAt = ctx.state.lastReceipt?.at ?? new Date().toISOString();
    console.log(
      `[agent] forzando validar_pago (comprobante leído cód=${ctx.state.lastReceipt?.securityCode}) convo=${ctx.conversationId}`,
    );
  }

  // Presentación determinista: lead que llega por un anuncio vinculado a un
  // producto (state.selectedProductId sembrado) y abre el chat por primera vez.
  // No puede depender del modelo (pasó en prod: producto en foco perfecto y el
  // modelo saludó genérico sin presentar). Solo primer contacto real: campañas
  // y recordatorios ya tienen mensajes del negocio en el historial y se excluyen.
  const forcePresentation = !forceValidation && shouldForcePresentation(ctx, history);
  if (forcePresentation) {
    console.log(
      `[agent] forzando enviar_ficha (producto en foco ${ctx.state.selectedProductId} sin presentar, primer contacto) convo=${ctx.conversationId}`,
    );
  }

  // Entrega por correo determinista: si el cliente escribió un correo (solo o
  // junto al comprobante: "Enviar a: juan@gmail.com"), eso ES pedir el acceso
  // por email. No puede depender del modelo (pasó en prod: el correo llegó con
  // la captura, el pago se aprobó en 2º plano y el correo nunca salió). Se
  // guarda en el estado (pendingDeliveryEmail) y en la ficha del cliente; si el
  // pago YA está aprobado se fuerza entregar_por_correo en la 1ª iteración; si
  // el comprobante viene en el mismo lote, el pendiente lo cumple la aprobación.
  let forceEmailDelivery = false;
  const inboundEmail = inboundText && emailDeliveryAvailable(ctx.config) ? extractEmail(inboundText) : null;
  // El historial "trailing" puede seguir incluyendo el mensaje del correo si el
  // bot cerró el turno sin texto: si ya se entregó a ese correo y no hay un
  // comprobante nuevo desde entonces, no es un pedido nuevo.
  const emailAlreadyServed =
    !!inboundEmail &&
    ctx.state.lastEmailDeliveredTo === inboundEmail &&
    !!ctx.state.lastEmailDeliveryAt &&
    !(ctx.state.lastReceipt?.at && ctx.state.lastReceipt.at > ctx.state.lastEmailDeliveryAt);
  if (inboundEmail && !emailAlreadyServed) {
    ctx.state.pendingDeliveryEmail = inboundEmail;
    if (!ctx.simulate) {
      await prisma.customer
        .updateMany({ where: { id: ctx.customerId, companyId: ctx.companyId }, data: { email: inboundEmail } })
        .catch(() => null);
    }
    const paid =
      ctx.state.status === "PAGADO" ||
      ctx.state.status === "ENTREGADO" ||
      (Array.isArray(ctx.state.purchasedProductIds) && ctx.state.purchasedProductIds.length > 0);
    if (paid && !forceValidation && !forcePresentation) {
      forceEmailDelivery = true;
      console.log(`[agent] forzando entregar_por_correo (correo ${inboundEmail} con pago aprobado) convo=${ctx.conversationId}`);
    } else {
      messages.push({
        role: "system",
        content:
          `El cliente escribió su correo (${inboundEmail}) para recibir el acceso: el sistema lo guardó como correo pendiente. ` +
          (forceValidation
            ? `Tras validar y entregar en este turno, llama entregar_por_correo con email "${inboundEmail}". Si el pago queda en validación, dile en UNA línea que apenas se confirme le llega también a ese correo (el sistema lo envía solo).`
            : `Si su pago ya está aprobado, llama entregar_por_correo con email "${inboundEmail}". Si aún no pagó, NO envíes nada: dile que apenas confirmes su pago se lo envías también a ese correo y sigue el flujo de pago normal.`),
      });
    }
  }

  // Notas de voz: un revisor decide si este mensaje cumple la regla «cuándo» del dueño.
  // Si cumple, se le indica al modelo y más abajo se exige la nota (no queda a su criterio).
  const voiceDue =
    voiceToolAvailable(ctx.config) && !forceValidation && !forcePresentation && !forceEmailDelivery && (await voiceRuleApplies(ctx, history));
  if (voiceDue) {
    messages.push({ role: "user", content: VOICE_DUE_NOTE });
    (ctx.guardEvents ??= []).push("nota de voz: el mensaje cumple la regla del dueño");
  }
  let voiceRetried = false;
  let forceVoiceNext = false;

  // El historial debe terminar en el cliente (ver TRAILING_ASSISTANT_NOTE). Va al final,
  // después de las notas de sistema, para que sea el último mensaje de la petición.
  const trailingAssistant = history.length > 0 && history[history.length - 1].role === "assistant";
  if (trailingAssistant) {
    messages.push({ role: "user", content: trailingAssistantNote(history) });
    console.log(`[agent] historial termina en el bot (cliente escribió durante la respuesta): nota de cierre convo=${ctx.conversationId}`);
  }

  let internalNoteRetried = false;
  let toolNameRetried = false;
  const toolNames = new Set(toolDefinitionsFor(ctx.config).map((t) => t.function.name.toLowerCase()));
  let mpLinkGuardTried = false;
  const postponeGuardOn = postponeAvailable(ctx.config);
  let postponeGuardTried = false;
  let postponePromise = "";
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await chatCompletion({
      apiKey,
      model: ctx.config.openai.model,
      baseUrl: ctx.config.openai.baseUrl,
      temperature: ctx.config.openai.temperature,
      messages,
      tools: toolDefinitionsFor(ctx.config),
      toolChoice:
        i === 0 && forceValidation
          ? { type: "function", function: { name: "validar_pago" } }
          : i === 0 && forcePresentation
            ? { type: "function", function: { name: "enviar_ficha" } }
            : i === 0 && forceEmailDelivery
              ? { type: "function", function: { name: "entregar_por_correo" } }
              : forceVoiceNext
                ? { type: "function", function: { name: "enviar_nota_de_voz" } }
                : "auto",
    });
    forceVoiceNext = false;

    if (res.toolCalls.length) {
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        let parsed: Record<string, any> = {};
        try {
          parsed = JSON.parse(call.function.arguments || "{}");
        } catch {
          parsed = {};
        }
        (ctx.toolsCalled ??= []).push(call.function.name);
        const result = await executeTool(call.function.name, parsed, ctx).catch((err) =>
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "tool error" }),
        );
        logTool(ctx, call.function.name, result);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      // Turno cerrado por el sistema: una herramienta ya dejó la respuesta para el cliente
      // (pidió el dato del pago, avisó que está validando, derivó a un asesor…). No se
      // vuelve a consultar al modelo: callar no puede depender de que obedezca.
      if (ctx.turnClosed) {
        (ctx.guardEvents ??= []).push(`turno cerrado por el sistema: ${ctx.turnClosed}`);
        console.log(`[agent] turno cerrado por el sistema (${ctx.turnClosed}) convo=${ctx.conversationId}`);
        return "";
      }
      continue;
    }

    // Sin tool_calls => texto final para el cliente. Si el modelo no agrega texto
    // pero alguna herramienta ya envió contenido al cliente (outbox), devolvemos
    // "" para NO mandar un segundo mensaje redundante. El FALLBACK solo aplica
    // cuando no se envió nada en todo el turno — y NUNCA si el comprobante del
    // cliente ya se gestionó por fuera (auto-validación), para no tapar ese
    // mensaje con el genérico "tuve un problema".
    let final = finalReply(res.content);
    // Freno del cierre repetido: en el turno que corre porque el cliente escribió durante
    // la respuesta, un texto igual a uno que el bot ya envió no sale otra vez.
    if (trailingAssistant && final && repeatsRecentBotText(final, history)) {
      (ctx.guardEvents ??= []).push(REPEATED_CLOSING_EVENT);
      console.warn(`[agent] cierre repetido descartado (cliente escribió durante la respuesta) convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
      return "";
    }
    // Guardia de la nota de voz: la regla del dueño se cumplía y el modelo contestó por
    // texto. Ese texto no sale: se le obliga a decirlo en una nota de voz (un intento).
    // No aplica si la voz falló por la cuenta o el tope del día (ahí sí va el texto).
    if (final && voiceDue && !voiceRetried && !ctx.voiceSentThisTurn && !ctx.voiceUnavailableThisTurn) {
      voiceRetried = true;
      forceVoiceNext = true;
      (ctx.guardEvents ??= []).push("nota de voz: el modelo respondió por texto, el sistema exigió la nota");
      console.warn(`[agent] regla de voz cumplida y respuesta por texto (se exige la nota) convo=${ctx.conversationId}`);
      messages.push({ role: "assistant", content: final });
      messages.push({ role: "user", content: voiceRetryNote(ctx.config.agent.voiceTool?.maxChars ?? 400) });
      continue;
    }
    if (final && isInternalNote(final)) {
      if (!internalNoteRetried) {
        internalNoteRetried = true;
        console.warn(`[agent] nota interna del modelo (reintento) convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
        messages.push({ role: "user", content: INTERNAL_NOTE_RETRY });
        continue;
      }
      console.warn(`[agent] nota interna descartada tras reintento convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
      return "";
    }
    // Freno de nombres internos: un texto que nombra una herramienta no sale. Primero se
    // le pide al modelo que lo reescriba (o que llame a la herramienta); si insiste, se
    // quitan las frases que la nombran y el resto sigue por las demás guardias.
    const leaked = final ? leakedToolNames(final, toolNames) : [];
    if (leaked.length) {
      if (!toolNameRetried) {
        toolNameRetried = true;
        (ctx.guardEvents ??= []).push(`nombre interno en el texto (${leaked.join(", ")}): se le pidió al modelo reescribirlo`);
        console.warn(`[agent] nombre interno de herramienta en el texto (reintento) convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
        messages.push({ role: "assistant", content: final });
        messages.push({ role: "user", content: toolNameRetryNote(leaked) });
        continue;
      }
      (ctx.guardEvents ??= []).push(`nombre interno descartado (${leaked.join(", ")}): se quitó la frase`);
      console.warn(`[agent] nombre interno de herramienta descartado tras reintento convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
      final = stripToolNameSentences(final, toolNames);
    }
    // Guardia del link pegado a mano: el texto trae un link de pago de Mercado Pago que
    // escribió el modelo (pasó en prod: copió el link viejo del chat en vez de llamar a
    // la herramienta, así que no se generó uno nuevo ni se levantó la pausa de
    // seguimiento). Ese texto no sale: si en el turno aún no se envió un link, se envía
    // uno nuevo con enviar_metodos_pago y el modelo reescribe su cierre sin la URL.
    // Comparte el intento único por turno con la guardia de la promesa.
    if (final && mpGuardOn && pastesMpLink(final, systemPrompt)) {
      if (!mpLinkGuardTried) {
        mpLinkGuardTried = true;
        let result = "";
        if (!ctx.mpLinkSentThisTurn) {
          result = await executeTool("enviar_metodos_pago", { soloLink: true }, ctx).catch((err) =>
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "tool error" }),
          );
          logTool(ctx, "enviar_metodos_pago", result, true);
          if (ctx.mpLinkSentThisTurn) (ctx.toolsCalled ??= []).push("enviar_metodos_pago");
        }
        const sent = Boolean(ctx.mpLinkSentThisTurn);
        console.warn(
          `[agent] link de pago escrito a mano (guardia: ${sent ? "enviado por la herramienta" : "no se pudo enviar"}) convo=${ctx.conversationId}: ${final.slice(0, 160)}`,
        );
        messages.push({ role: "assistant", content: final });
        messages.push({ role: "user", content: mpLinkGuardNote(sent, result, "pasted") });
        continue;
      }
      console.warn(`[agent] link de pago escrito a mano descartado tras la guardia convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
      return ctx.outbox.length ? "" : FALLBACK_TEXT;
    }
    // Guardia del link de pago: el texto promete el link de Mercado Pago («te paso el
    // link 👇») pero en este turno no salió ninguno, porque el modelo no llamó a la
    // herramienta (pasó en prod: el cliente se quedó esperando el link). Se envía de
    // verdad con los controles de siempre de enviar_metodos_pago y el modelo reescribe
    // su cierre sabiendo el resultado. Una sola vez por turno.
    if (final && mpGuardOn && promisesPaymentLink(final, ctx.state)) {
      if (!mpLinkGuardTried && !ctx.mpLinkSentThisTurn) {
        mpLinkGuardTried = true;
        const result = await executeTool("enviar_metodos_pago", { soloLink: true }, ctx).catch((err) =>
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "tool error" }),
        );
        logTool(ctx, "enviar_metodos_pago", result, true);
        const sent = Boolean(ctx.mpLinkSentThisTurn);
        // Con el link ya enviado aplica la misma guarda de texto redundante que tras un cobro normal.
        if (sent) (ctx.toolsCalled ??= []).push("enviar_metodos_pago");
        console.warn(
          `[agent] link de pago prometido sin herramienta (guardia: ${sent ? "enviado" : "no se pudo enviar"}) convo=${ctx.conversationId}: ${final.slice(0, 160)}`,
        );
        messages.push({ role: "assistant", content: final });
        messages.push({ role: "user", content: mpLinkGuardNote(sent, result) });
        continue;
      }
      // Tras la guardia, un cierre que vuelve a prometer el link no sale: el link ya está
      // en el chat o no se pudo generar.
      if (mpLinkGuardTried) {
        console.warn(`[agent] promesa de link descartada tras la guardia convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
        return ctx.outbox.length ? "" : FALLBACK_TEXT;
      }
    }
    // Guardia de la fecha prometida: el texto promete escribirle al cliente en un día u
    // hora («te escribo el lunes a las 9») pero en el turno no se llamó a
    // posponer_seguimiento (pasó en prod: no quedó nada programado y esa noche salió el
    // recordatorio del carrito). Primero se le exige al modelo que la programe; si
    // vuelve a prometer sin programar, el sistema la programa con el mensaje de respaldo.
    if (postponeGuardOn && postponeGuardApplies(ctx)) {
      if (final && !postponeGuardTried && promisesFollowupDate(final) && !restatesActivePostpone(ctx, final, inboundText)) {
        postponeGuardTried = true;
        postponePromise = final;
        (ctx.guardEvents ??= []).push("fecha prometida sin posponer: se le exigió al modelo programarla");
        console.warn(`[agent] fecha prometida sin herramienta (guardia: nota al modelo) convo=${ctx.conversationId}: ${final.slice(0, 160)}`);
        messages.push({ role: "assistant", content: final });
        messages.push({ role: "user", content: POSTPONE_GUARD_NOTE });
        continue;
      }
      if (postponeGuardTried && (!final || promisesFollowupDate(final))) {
        const promise = final || postponePromise;
        await systemPostpone(ctx, promise, inboundText);
        return promise;
      }
    }
    // Tras descartar una nota interna, el silencio es la respuesta correcta (sin el genérico).
    if (internalNoteRetried && !final) return "";
    // Tras la guardia del link, sin nada más que decir, el link enviado es la respuesta.
    if (mpLinkGuardTried && !final && ctx.mpLinkSentThisTurn) return "";
    if (trailingAssistant && !final) return "";
    return final || (suppressFallback(ctx, history) ? "" : FALLBACK_TEXT);
  }

  // Si agotó iteraciones, fuerza un cierre en texto sin herramientas
  const closing = await chatCompletion({
    apiKey,
    model: ctx.config.openai.model,
    baseUrl: ctx.config.openai.baseUrl,
    temperature: ctx.config.openai.temperature,
    messages: [
      ...messages,
      { role: "user", content: "Cierra el turno con un mensaje breve y claro para el cliente." },
    ],
  }).catch(() => null);

  let closingText = finalReply(closing?.content);
  const closingLeak = closingText ? leakedToolNames(closingText, toolNames) : [];
  if (closingLeak.length) {
    (ctx.guardEvents ??= []).push(`nombre interno descartado (${closingLeak.join(", ")}): se quitó la frase`);
    console.warn(`[agent] nombre interno de herramienta descartado en el cierre convo=${ctx.conversationId}: ${closingText.slice(0, 160)}`);
    closingText = stripToolNameSentences(closingText, toolNames);
  }
  if (trailingAssistant && closingText && repeatsRecentBotText(closingText, history)) {
    (ctx.guardEvents ??= []).push(REPEATED_CLOSING_EVENT);
    console.warn(`[agent] cierre repetido descartado en el cierre (cliente escribió durante la respuesta) convo=${ctx.conversationId}: ${closingText.slice(0, 160)}`);
    return "";
  }
  if (closingText && isInternalNote(closingText)) {
    console.warn(`[agent] nota interna descartada en el cierre convo=${ctx.conversationId}: ${closingText.slice(0, 160)}`);
    return "";
  }
  if (closingText && mpGuardOn && pastesMpLink(closingText, systemPrompt)) {
    console.warn(`[agent] link de pago escrito a mano descartado en el cierre convo=${ctx.conversationId}: ${closingText.slice(0, 160)}`);
    return ctx.outbox.length ? "" : FALLBACK_TEXT;
  }
  if (
    closingText &&
    postponeGuardOn &&
    postponeGuardApplies(ctx) &&
    promisesFollowupDate(closingText) &&
    !restatesActivePostpone(ctx, closingText, inboundText)
  ) {
    await systemPostpone(ctx, closingText, inboundText);
  }
  if (trailingAssistant && !closingText) return "";
  return closingText || (suppressFallback(ctx, history) ? "" : FALLBACK_TEXT);
}

/**
 * ¿Corresponde forzar validar_pago en este turno? Solo el caso Yape con CÓDIGO
 * de seguridad leído por visión (con código la validación no necesita nada del
 * modelo; Plin/sin código sigue el flujo conversacional). Condiciones:
 * comprobante fresco (<10 min), aún no forzado para ESTE comprobante
 * (receiptAutoHandledAt marca el `at` ya gestionado) y venta no cerrada/derivada.
 */
/**
 * ¿Forzar la presentación del producto en foco? Solo el caso "lead de anuncio
 * recién llegado": hay selectedProductId sembrado (catálogo de anuncios), ese
 * producto NUNCA se presentó, y es el primer contacto real del chat (sin
 * mensajes previos del negocio — campañas/recordatorios quedan fuera).
 */
function shouldForcePresentation(ctx: TurnContext, history: ChatMessage[]): boolean {
  const productId = ctx.state.selectedProductId;
  if (!productId) return false;
  if ((ctx.state.presentedProductIds ?? []).includes(productId)) return false;
  if (history.some((m) => m.role === "assistant")) return false;
  // El producto debe existir en el catálogo activo del bot (si fue desactivado,
  // dejar que el modelo maneje el turno con normalidad).
  if (!ctx.config.products.some((p) => p.id === productId)) return false;
  return true;
}

/**
 * «La reviso yo»: ¿hay una captura de pago fresca (<10 min) que aún no se reportó
 * al dueño? No exige código: cualquier comprobante leído se deriva.
 */
function shouldReportReceipt(ctx: TurnContext): boolean {
  if (!ownerReviewsPayments(ctx.config.payment)) return false;
  const r = ctx.state.lastReceipt;
  if (!r?.at) return false;
  if (Date.now() - new Date(r.at).getTime() > 10 * 60 * 1000) return false;
  if (ctx.state.receiptAutoHandledAt === r.at) return false;
  const status = ctx.state.status ?? "";
  return !(status === "PAGADO" || status === "ENTREGADO" || status === "ASESOR_HUMANO");
}

function shouldForceValidation(ctx: TurnContext): boolean {
  if (ownerReviewsPayments(ctx.config.payment)) return false;
  const r = ctx.state.lastReceipt;
  if (!r?.securityCode || !r.at) return false;
  if (Date.now() - new Date(r.at).getTime() > 10 * 60 * 1000) return false;
  if (ctx.state.receiptAutoHandledAt === r.at) return false;
  const status = ctx.state.status ?? "";
  if (status === "PAGADO" || status === "ENTREGADO" || status === "ASESOR_HUMANO") return false;
  return true;
}

/**
 * NUNCA mandar el genérico "tuve un problema" cuando el último mensaje del cliente
 * fue una IMAGEN (el modelo no la ve; el comprobante se gestiona aparte) o cuando
 * se acaba de leer/auto-gestionar un comprobante: taparía la validación del pago.
 */
function suppressFallback(ctx: TurnContext, history: ChatMessage[]): boolean {
  if (ctx.outbox.length) return true;
  // Un sticker solo ya es una respuesta (p. ej. al «gracias» del cliente).
  if (ctx.stickerSentThisTurn) return true;
  const recent =(iso?: string | null) => (iso ? Date.now() - new Date(iso).getTime() < 90 * 1000 : false);
  if (recent(ctx.state.receiptAutoHandledAt) || recent(ctx.state.lastReceipt?.at)) return true;
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  return typeof lastUser?.content === "string" && lastUser.content.includes("[el cliente envió una imagen");
}
