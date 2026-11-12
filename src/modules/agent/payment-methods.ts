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
