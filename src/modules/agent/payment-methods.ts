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
import type { ConversationState } from "./conversation.service";

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

/**
 * Arma el texto de cobro (monto + métodos manuales + link MP) y, si crea el
 * link, muta `state.mpPreferenceId/mpAmount`. En simulación no crea el link.
 *
 * `mpLink`: "auto" (default) = métodos manuales y, según el modo del negocio, el
 * link dentro del mismo mensaje; "only" = mensaje corto SOLO con el link (el cliente
 * lo pidió). Con "only", `text` vacío significa que no hubo link que enviar.
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
  if (wantLink && mpCfg?.accessTokenEnc) {
    linkAmount = mpLinkAmount(opts.amountNum, mpCfg as Parameters<typeof mpLinkAmount>[1]);
    if (!opts.simulate) {
      try {
        const token = decryptCredential(mpCfg.accessTokenEnc);
        const pref = await mpCreatePreference(token, {
          title: opts.title,
          amount: linkAmount,
          currency: (opts.currency ?? "PEN").toUpperCase(),
          externalReference: JSON.stringify({
            conversationId: opts.conversationId,
            productIds: opts.productIds,
          }),
          notificationUrl: `${env.PUBLIC_BASE_URL}/api/webhooks/mercadopago/${opts.companyId}`,
        });
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
  const withFee = mpCfg?.feeMode === "CUSTOMER" && linkAmount > opts.amountNum;

  // Solo el link (el cliente pidió pagar por ahí): mensaje corto y aparte.
  if (mode === "only") {
    if (!link) return { text: "", mpLinkIncluded: false, mpLinkAvailable: Boolean(mpAllowed), mpLinkFailed };
    const amountLine = withFee
      ? `Son *${symbol} ${linkAmount.toFixed(2)}* por el link (incluye la comisión de Mercado Pago) 😊`
      : `Son *${opts.amountText}* 😊`;
    const text =
      `${amountLine}\n\n` +
      `💳 Paga con tarjeta y otros medios por aquí:\n${link}\n\n` +
      `La confirmación es automática: en cuanto se apruebe el pago te llega tu pedido ✅`;
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
    : `Paga con el link de abajo y, en cuanto se confirme, te llega tu pedido ✅`;
  const text = `Son *${opts.amountText}* 😊\n\n` + manualBlock + mpLine;
  return { text, mpLinkIncluded: Boolean(mpLine), mpLinkAvailable: Boolean(mpAllowed), mpLinkFailed };
}
