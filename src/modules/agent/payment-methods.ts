/**
 * Mensaje de cobro compartido (métodos manuales Yape/Plin + link de Mercado
 * Pago). Lo consumen la tool `enviar_metodos_pago` del agente IA y el bloque
 * «Validar pago» del chatbot de flujos — módulo neutral para evitar ciclos.
 */

import { env } from "../../config/env";
import { symbolFor } from "../../lib/currency";
import { decryptCredential } from "../../lib/credentials-crypto";
import { mpCreatePreference, mpLinkAmount } from "../../lib/mercadopago-client";
import { getEntitlements } from "../billing/entitlements";
import { formatPostponeDate } from "../scheduler/smart-followup";
import type { ConversationState } from "./conversation.service";
import { applySpintax } from "./reminder-templates";

interface PaymentMethodEntry {
  method: string;
  number: string;
  holder: string;
}

interface MpConfigLike {
  enabled?: boolean;
  accessTokenEnc?: string | null;
  feeMode?: string | null;
  feePercent?: number | null;
  feeFixed?: number | null;
  feeIgv?: boolean | null;
  /** Mercado Pago habilitado para el cobro por chat (default true). */
  chatEnabled?: boolean | null;
  /** "ALWAYS" (default) = link en el mensaje de cobro; "ON_REQUEST" = solo si el cliente lo pide. */
  chatMode?: string | null;
  /** Mensaje propio del link enviado aparte (null = el de fábrica). */
  chatLinkMessage?: string | null;
  /** Vigencia del link del chat en días, de 1 a 30 (null = no vence). */
  chatLinkExpiryDays?: number | null;
}

export interface PaymentConfigLike {
  enabled?: boolean;
  methods: PaymentMethodEntry[];
  mp?: MpConfigLike | null;
  /** Mensaje de cobro propio del negocio (null = el de fábrica). */
  chargeMessage?: string | null;
  /** Mensaje propio del cobro de adelanto de un pedido (null = el de fábrica). */
  advanceChargeMessage?: string | null;
  /** "AUTO" (default) = el agente valida los pagos; "OWNER" = el dueño revisa cada pago. */
  receiptReviewMode?: string | null;
  /** Respuesta al cliente cuando el dueño revisa el pago (null = la de fábrica). */
  receiptReviewMessage?: string | null;
}

export const RECEIPT_REVIEW_MESSAGE_MAX = 300;
/** Respuesta de fábrica al cliente cuando el dueño revisa los pagos a mano. */
export const DEFAULT_RECEIPT_REVIEW_MESSAGE = "¡Gracias! Ya lo reviso y te confirmo en un ratito 🙌";
/** Motivo de la derivación cuando el pago queda a la espera del dueño. */
export const OWNER_REVIEW_HANDOFF = "HUMAN[PAGO_POR_CONFIRMAR]";

/** ¿El dueño revisa cada pago? (Pagos → Validación de comprobantes: «La reviso yo»). */
export function ownerReviewsPayments(payment: { receiptReviewMode?: string | null } | null | undefined): boolean {
  return payment?.receiptReviewMode === "OWNER";
}

/** Datos del cobro para el mensaje propio del negocio (no cambian el mensaje de fábrica). */
export interface ChargeInfo {
  /** "advance" = se paga una parte ahora y queda saldo; "total" = todo lo demás. */
  kind: "total" | "advance";
  nombre?: string | null;
  /** Total del pedido o de la compra, ya con símbolo. */
  total?: string | null;
  /** Lo que queda por pagar después de este cobro (solo en adelantos). */
  saldo?: string | null;
  /** Código del pedido (solo cuando el cobro es de un pedido). */
  pedido?: string | null;
}

export const CHARGE_MESSAGE_MAX = 600;
const CHARGE_CLOSING =
  "Cuando pagues, envíame la *captura* o el *nombre del titular* de tu Yape/Plin (desde donde pagaste) y te confirmo al instante ✅";
/** Equivalentes de fábrica escritos con variables: el panel los muestra como punto de partida. */
export const DEFAULT_CHARGE_MESSAGE = `Son *{monto}* 😊\n\n{metodos}\n\n${CHARGE_CLOSING}`;
export const DEFAULT_ADVANCE_CHARGE_MESSAGE =
  "Adelanto del pedido *{pedido}*: *{monto}* 😊\n" +
  `Total {total} · después queda un saldo de {saldo}\n\n{metodos}\n\n${CHARGE_CLOSING}`;

/** Un mensaje de cobro propio debe decir cuánto y a dónde pagar. null = válido. */
export function chargeTemplateError(template: string | null | undefined): string | null {
  const text = (template ?? "").trim();
  if (!text) return null;
  if (text.length > CHARGE_MESSAGE_MAX) {
    return `El mensaje de cobro admite hasta ${CHARGE_MESSAGE_MAX} caracteres (tiene ${text.length})`;
  }
  const missing = ["{monto}", "{metodos}"].filter((v) => !text.toLowerCase().includes(v));
  return missing.length ? `Al mensaje de cobro le falta ${missing.join(" y ")}` : null;
}

/** Medios de pago para el mensaje propio: sin negritas; uno solo va en línea, varios uno por línea. */
function plainMethods(methods: PaymentMethodEntry[]): string {
  if (methods.length === 1) {
    const m = methods[0];
    return `${m.method} ${m.number} (${m.holder})`;
  }
  return methods.map((m) => `• ${m.method}: ${m.number} (${m.holder})`).join("\n");
}

/**
 * Mensaje de cobro propio: primero las variantes {a|b} y después las variables.
 * Una línea que usa {total}, {saldo} o {pedido} sin valor se omite, salvo que sea
 * la línea del monto o de los medios de pago (ahí la variable solo se quita).
 * Devuelve null si el texto no trae {monto} y {metodos}: el cobro sale con el de fábrica.
 */
export function renderChargeMessage(
  template: string,
  vars: { nombre?: string | null; monto: string; total?: string | null; saldo?: string | null; pedido?: string | null; metodos: string },
): string | null {
  if (chargeTemplateError(template) || !template.trim()) return null;
  const optional: Record<string, string> = {
    total: (vars.total ?? "").trim(),
    saldo: (vars.saldo ?? "").trim(),
    pedido: (vars.pedido ?? "").trim(),
  };
  const nombre = (vars.nombre ?? "").trim();
  let out = applySpintax(template.trim())
    .split("\n")
    .filter((line) => {
      if (/\{(monto|metodos)\}/i.test(line)) return true;
      return !Object.keys(optional).some((k) => !optional[k] && new RegExp(`\\{${k}\\}`, "i").test(line));
    })
    .join("\n");
  // Sin nombre: se quita la variable con el espacio que la precede («Listo {nombre},» → «Listo,»).
  out = nombre ? out.replace(/\{nombre\}/gi, () => nombre) : out.replace(/[^\S\n]*\{nombre\}/gi, "");
  out = out
    .replace(/\{monto\}/gi, () => vars.monto)
    .replace(/\{total\}/gi, () => optional.total)
    .replace(/\{saldo\}/gi, () => optional.saldo)
    .replace(/\{pedido\}/gi, () => optional.pedido)
    .replace(/\{metodos\}/gi, () => vars.metodos)
    // Restos de una variable vacía: signo suelto al inicio de línea y espacios dobles.
    .replace(/^[^\S\n]*[,;:][^\S\n]*/gm, "")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out || null;
}

/** ¿Mercado Pago está encendido para el cobro por chat? (maestro + token + canal chat). */
export function mpChatOn(payment: PaymentConfigLike | null | undefined): boolean {
  const mp = payment?.mp;
  return Boolean(mp?.enabled && mp.chatEnabled !== false);
}

/**
 * ¿El link va SOLO cuando el cliente lo pide? Aplica con el modo ON_REQUEST y al
 * menos un método manual: un negocio que solo cobra por Mercado Pago lo envía siempre.
 */
export function mpLinkOnRequest(payment: PaymentConfigLike | null | undefined): boolean {
  return mpChatOn(payment) && payment?.mp?.chatMode === "ON_REQUEST" && (payment?.methods.length ?? 0) > 0;
}

/** Mensaje de fábrica del link enviado aparte (modo "only"). El panel lo muestra como referencia. */
export const DEFAULT_MP_LINK_MESSAGE =
  "Son *{monto}* 😊\n\n" +
  "💳 Paga con tarjeta y otros medios por aquí:\n{link}\n\n" +
  "La confirmación es automática: en cuanto se apruebe el pago te llega tu pedido ✅";
// Variante de fábrica cuando la comisión del link la paga el cliente.
export const DEFAULT_MP_LINK_MESSAGE_WITH_FEE = DEFAULT_MP_LINK_MESSAGE.replace(
  "*{monto}*",
  "*{monto}* por el link (incluye la comisión de Mercado Pago)",
);
export const MP_LINK_MESSAGE_MAX = 600;

/** Días de vigencia del link del chat (1 a 30); null = no vence. */
export function mpLinkExpiryDays(payment: PaymentConfigLike | null | undefined): number | null {
  const days = Number(payment?.mp?.chatLinkExpiryDays);
  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : null;
}

/**
 * Mensaje del link enviado aparte: primero las variantes {a|b} y después las
 * variables {monto}, {link} y {vence}. Si el link no vence, las líneas que usan
 * {vence} se omiten; si el texto no trae {link}, el link va al final (nunca se pierde).
 */
export function renderMpLinkMessage(
  template: string,
  vars: { monto: string; link: string; vence?: string | null },
): string {
  let out = applySpintax(template.slice(0, MP_LINK_MESSAGE_MAX));
  if (!vars.vence) {
    out = out
      .split("\n")
      .filter((line) => !/\{vence\}/i.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  const hasLink = /\{link\}/i.test(out);
  out = out
    .replace(/\{monto\}/gi, () => vars.monto)
    .replace(/\{vence\}/gi, () => vars.vence ?? "")
    .replace(/\{link\}/gi, () => vars.link)
    .trim();
  return hasLink ? out : `${out}\n\n${vars.link}`;
}

/** Pago aprobado o venta cerrada: el link enviado ya no cuenta para una compra futura. */
export function clearMpLinkState(state: ConversationState): void {
  state.mpLinkSentAt = null;
  state.mpLinkBaseAmount = null;
  state.mpLinkExpiresAt = null;
}

/**
 * Arma el texto de cobro (monto + métodos manuales + link MP) y, si crea el
 * link, muta `state.mpPreferenceId/mpAmount` y deja anotado que el cliente ya
 * tiene un link (`mpLinkSentAt/mpLinkBaseAmount/mpLinkExpiresAt`). En simulación no crea el link.
 *
 * `mpLink`: "auto" (default) = métodos manuales y, según el modo del negocio, el
 * link dentro del mismo mensaje; "only" = mensaje corto SOLO con el link (el cliente
 * lo pidió), con el texto propio del negocio si lo configuró. Con "only", `text`
 * vacío significa que no hubo link que enviar.
 */
export async function composePaymentMethodsMessage(opts: {
  companyId: string;
  conversationId: string;
  payment: PaymentConfigLike;
  state: ConversationState;
  amountNum: number;
  amountText: string;
  /** Moneda del negocio ("PEN" default): símbolo del texto y currency_id del link MP. */
  currency?: string;
  title: string;
  productIds: string[];
  simulate?: boolean;
  mpLink?: "auto" | "only";
  /** Zona horaria del negocio, para mostrar la fecha de vencimiento ({vence}). */
  timezone?: string;
  /**
   * Cobro de un pedido con «Envíos»: reemplaza el «Son *monto*» por el concepto
   * (adelanto, saldo o total), el código del pedido y los montos.
   */
  head?: string;
  /** Pedido al que se acredita el pago del link (viaja en la referencia de Mercado Pago). */
  orderId?: string;
  /** Datos para el mensaje de cobro propio del negocio; sin texto propio no se usan. */
  charge?: ChargeInfo;
}): Promise<{
  text: string;
  mpLinkIncluded: boolean;
  /** Hay link de Mercado Pago para este cobro (aunque no se haya incluido en el mensaje). */
  mpLinkAvailable: boolean;
  /** Se intentó crear el link y Mercado Pago falló (token vencido, red). */
  mpLinkFailed: boolean;
}> {
  const mpCfg = opts.payment.mp;
  const mode = opts.mpLink ?? "auto";

  // Mercado Pago: link de pago (Checkout Pro) junto a los métodos manuales.
  // Si falla la creación (token vencido, red), degradar sin romper el cobro.
  // El módulo MERCADOPAGO del paquete gatea el link (legacy pasa; cache 60s).
  const mpAllowed =
    mpChatOn(opts.payment) && mpCfg?.accessTokenEnc && opts.amountNum > 0
      ? await getEntitlements(opts.companyId)
          .then((ent) => ent.legacy || ent.modules.includes("MERCADOPAGO"))
          .catch(() => true)
      : false;
  // En modo "a pedido" el cobro normal va sin link; "only" lo fuerza.
  const wantLink = mpAllowed && (mode === "only" || !mpLinkOnRequest(opts.payment));
  const symbol = symbolFor(opts.currency);
  let link = "";
  let linkAmount = opts.amountNum;
  let mpLinkFailed = false;
  // Vigencia opcional del link del chat (apagada por defecto: el link no vence).
  const expiryDays = wantLink ? mpLinkExpiryDays(opts.payment) : null;
  let expiresAt: Date | null = expiryDays ? new Date(Date.now() + expiryDays * 86_400_000) : null;
  if (wantLink && mpCfg?.accessTokenEnc) {
    linkAmount = mpLinkAmount(opts.amountNum, mpCfg as Parameters<typeof mpLinkAmount>[1]);
    if (!opts.simulate) {
      try {
        const token = decryptCredential(mpCfg.accessTokenEnc);
        const prefOpts = {
          title: opts.title,
          amount: linkAmount,
          currency: (opts.currency ?? "PEN").toUpperCase(),
          externalReference: JSON.stringify({
            conversationId: opts.conversationId,
            productIds: opts.productIds,
            // Solo en pedidos con «Envíos»: a qué pedido va y cuánto se acredita (sin comisión).
            ...(opts.orderId ? { orderId: opts.orderId, baseAmount: opts.amountNum } : {}),
          }),
          notificationUrl: `${env.PUBLIC_BASE_URL}/api/webhooks/mercadopago/${opts.companyId}`,
        };
        const pref = await mpCreatePreference(token, expiresAt ? { ...prefOpts, expiresAt } : prefOpts).catch(
          (err) => {
            if (!expiresAt) throw err;
            // La vigencia es opcional: si Mercado Pago la rechaza, el link sale igual, sin vencer.
            console.warn(
              `[payments] MP preference con vencimiento falló company=${opts.companyId}; reintento sin vencimiento:`,
              err instanceof Error ? err.message : err,
            );
            expiresAt = null;
            return mpCreatePreference(token, prefOpts);
          },
        );
        link = pref.init_point;
        opts.state.mpPreferenceId = pref.id;
        opts.state.mpAmount = linkAmount;
      } catch (err) {
        mpLinkFailed = true;
        console.error(
          `[payments] MP preference falló company=${opts.companyId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    } else if (mode === "only") {
      // Simulador: no se crea un link real; se muestra uno de ejemplo.
      link = "https://mpago.la/ejemplo (link de muestra: en el chat real se genera el link de pago)";
    }
  }
  // El mensaje con link sale siempre que hay link: se anota para el contexto del agente
  // (los resultados de herramientas no sobreviven entre turnos).
  if (link) {
    opts.state.mpLinkSentAt = new Date().toISOString();
    opts.state.mpLinkBaseAmount = opts.amountNum;
    opts.state.mpAmount = linkAmount;
    opts.state.mpLinkExpiresAt = expiresAt ? expiresAt.toISOString() : null;
  }
  const withFee = mpCfg?.feeMode === "CUSTOMER" && linkAmount > opts.amountNum;

  // Solo el link (el cliente pidió pagar por ahí): mensaje corto y aparte.
  if (mode === "only") {
    if (!link) return { text: "", mpLinkIncluded: false, mpLinkAvailable: Boolean(mpAllowed), mpLinkFailed };
    const custom = (mpCfg?.chatLinkMessage ?? "").trim();
    const template =
      custom ||
      (opts.head
        ? `${opts.head}\n\n` +
          (withFee ? "💳 Por el link son *{monto}* (incluye la comisión de Mercado Pago):\n{link}" : "💳 Paga con tarjeta y otros medios por aquí:\n{link}") +
          "\n\nLa confirmación es automática: en cuanto se apruebe el pago te aviso ✅"
        : withFee
          ? DEFAULT_MP_LINK_MESSAGE_WITH_FEE
          : DEFAULT_MP_LINK_MESSAGE);
    const text = renderMpLinkMessage(template, {
      monto: withFee ? `${symbol} ${linkAmount.toFixed(2)}` : opts.amountText,
      link,
      vence: expiresAt ? formatPostponeDate(expiresAt, opts.timezone || "America/Lima") : null,
    });
    return { text, mpLinkIncluded: true, mpLinkAvailable: true, mpLinkFailed: false };
  }

  const mpLine = !link
    ? ""
    : withFee
    ? `\n\n💳 O con tarjeta por Mercado Pago (total ${symbol} ${linkAmount.toFixed(2)}, incluye la comisión):\n${link}`
    : `\n\n💳 O con tarjeta y otros medios por aquí:\n${link}`;

  // Mensaje de cobro propio del negocio (aditivo): solo con texto guardado para este
  // tipo de cobro y al menos un medio manual. Cualquier fallo cae al de fábrica de abajo.
  const ownTemplate = (
    (opts.charge?.kind === "advance" ? opts.payment.advanceChargeMessage : opts.payment.chargeMessage) ?? ""
  ).trim();
  if (ownTemplate && opts.payment.methods.length) {
    try {
      const own = renderChargeMessage(ownTemplate, {
        nombre: opts.charge?.nombre,
        monto: opts.amountText,
        total: opts.charge?.total ?? opts.amountText,
        saldo: opts.charge?.saldo,
        pedido: opts.charge?.pedido,
        metodos: plainMethods(opts.payment.methods),
      });
      if (own) {
        return { text: own + mpLine, mpLinkIncluded: Boolean(mpLine), mpLinkAvailable: Boolean(mpAllowed), mpLinkFailed };
      }
    } catch (err) {
      console.error(
        `[payments] mensaje de cobro propio falló company=${opts.companyId}; sale el de fábrica:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Texto corto y natural: monto → cuenta(s) → qué mandar para validar. Se
  // conservan las dos vías (captura o nombre del titular) y la aclaración de que
  // el nombre es el de SU cuenta: ambas evitan validaciones fallidas reales.
  const bullet = opts.payment.methods.length > 1 ? "• " : "";
  const methods = opts.payment.methods
    .map((m) => `${bullet}${m.method}: *${m.number}* (${m.holder})`)
    .join("\n");
  const manualBlock = methods
    ? `${methods}\n\n` +
      `Cuando pagues, envíame la *captura* o el *nombre del titular* de tu Yape/Plin (desde donde pagaste) y te confirmo al instante ✅`
    : opts.head
      ? `Paga con el link de abajo y, en cuanto se confirme, te aviso ✅`
      : `Paga con el link de abajo y, en cuanto se confirme, te llega tu pedido ✅`;
  const text = `${opts.head ?? `Son *${opts.amountText}* 😊`}\n\n` + manualBlock + mpLine;
  return { text, mpLinkIncluded: Boolean(mpLine), mpLinkAvailable: Boolean(mpAllowed), mpLinkFailed };
}
