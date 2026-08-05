/**
 * Mensaje de cobro compartido (métodos manuales Yape/Plin + link de Mercado
 * Pago). Lo consumen la tool `enviar_metodos_pago` del agente IA y el bloque
 * «Validar pago» del chatbot de flujos — módulo neutral para evitar ciclos.
 */

import { env } from "../../config/env";
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
}

export interface PaymentConfigLike {
  enabled?: boolean;
  methods: PaymentMethodEntry[];
  mp?: MpConfigLike | null;
}

/**
 * Arma el texto de cobro (monto + métodos manuales + link MP) y, si crea el
 * link, muta `state.mpPreferenceId/mpAmount`. En simulación no crea el link.
 */
export async function composePaymentMethodsMessage(opts: {
  companyId: string;
  conversationId: string;
  payment: PaymentConfigLike;
  state: ConversationState;
  amountNum: number;
  amountText: string;
  title: string;
  productIds: string[];
  simulate?: boolean;
}): Promise<{ text: string; mpLinkIncluded: boolean }> {
  const mpCfg = opts.payment.mp;

  // Mercado Pago: link de pago (Checkout Pro) junto a los métodos manuales.
  // Si falla la creación (token vencido, red), degradar sin romper el cobro.
  // El módulo MERCADOPAGO del paquete gatea el link (legacy pasa; cache 60s).
  let mpLine = "";
  const mpAllowed =
    !opts.simulate && mpCfg?.enabled && mpCfg.accessTokenEnc && opts.amountNum > 0
      ? await getEntitlements(opts.companyId)
          .then((ent) => ent.legacy || ent.modules.includes("MERCADOPAGO"))
          .catch(() => true)
      : false;
  if (mpAllowed && mpCfg?.accessTokenEnc) {
    try {
      const token = decryptCredential(mpCfg.accessTokenEnc);
      const linkAmount = mpLinkAmount(opts.amountNum, mpCfg as Parameters<typeof mpLinkAmount>[1]);
      const pref = await mpCreatePreference(token, {
        title: opts.title,
        amount: linkAmount,
        externalReference: JSON.stringify({
          conversationId: opts.conversationId,
          productIds: opts.productIds,
        }),
        notificationUrl: `${env.PUBLIC_BASE_URL}/api/webhooks/mercadopago/${opts.companyId}`,
      });
      mpLine =
        mpCfg.feeMode === "CUSTOMER" && linkAmount > opts.amountNum
          ? `\n\n💳 O paga con tarjeta u otros medios por Mercado Pago (total S/ ${linkAmount.toFixed(2)}, incluye la comisión de la pasarela):\n${pref.init_point}`
          : `\n\n💳 También puedes pagar con tarjeta u otros medios aquí:\n${pref.init_point}`;
      opts.state.mpPreferenceId = pref.id;
      opts.state.mpAmount = linkAmount;
    } catch (err) {
      console.error(
        `[payments] MP preference falló company=${opts.companyId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const methods = opts.payment.methods
    .map((m) => `• ${m.method}: *${m.number}* (titular: ${m.holder})`)
    .join("\n");
  const manualBlock = methods
    ? `Puedes pagar con:\n${methods}\n\n` +
      `Cuando pagues, mándame la *captura del comprobante* o el *nombre del titular* de tu Yape/Plin (la cuenta DESDE donde pagaste) y validamos tu pago al instante ✅`
    : `Paga de forma segura con el link de abajo; en cuanto se confirme el pago te llega tu pedido automáticamente ✅`;
  const text = `El monto a pagar es: *${opts.amountText}*\n\n` + manualBlock + mpLine;
  return { text, mpLinkIncluded: Boolean(mpLine) };
}
