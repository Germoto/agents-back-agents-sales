/**
 * Validación de la entrega de un pedido con «Envíos» encendido, compartida por el
 * agente (registrar_pedido) y la tienda web (checkout físico). Valida lo recibido
 * contra la configuración del negocio (tipo de entrega activo, agencia del catálogo,
 * DNI si se pide) y calcula envío, total y adelanto. No decide nada comercial: aplica
 * la regla de cobro que el dueño eligió para ese tipo de entrega.
 *
 * Devuelve CÓDIGOS de error, no textos: cada canal los traduce a su propio idioma
 * (el agente le habla al modelo; la tienda, al comprador).
 */

import type { OrderShippingInput } from "../agent/order.service";
import { findAgencyById } from "./agency-search";
import { computeOrderAmounts, enabledDeliveryTypes, parseDeliveryType, type DeliveryType, type ShippingConfig } from "./shipping-config";

export type OrderPayMode = "BEFORE_DELIVERY" | "CASH_ON_DELIVERY" | "MANUAL";

export type OrderShippingErrorCode =
  | "MISSING_TYPE"
  | "TYPE_DISABLED"
  | "MISSING_ADDRESS"
  | "MISSING_AGENCY"
  | "AGENCY_INVALID"
  | "MISSING_DOCUMENT"
  | "MISSING_PAYMENT_CHOICE";

/** Lo que llega del canal (sin validar): cada campo puede venir vacío o con cualquier tipo. */
export interface OrderShippingRequest {
  deliveryType?: unknown;
  address?: unknown;
  agencyId?: unknown;
  agencyText?: unknown;
  courier?: unknown;
  document?: unknown;
  recipientPhone?: unknown;
  /** Elección del cliente cuando el negocio deja elegir: 'adelantado' | 'contra_entrega'. */
  cobro?: unknown;
}

export type OrderShippingResult =
  | { ok: true; shipping: OrderShippingInput; paymentMode?: OrderPayMode }
  | { ok: false; code: OrderShippingErrorCode; deliveryType?: DeliveryType };

/**
 * Modo de cobro EFECTIVO de un pedido. Si el negocio dejó elegir al cliente
 * (CUSTOMER_CHOICE), la elección debe venir en `cobro`; sin ella `missingChoice`.
 * En los demás modos manda la configuración y `cobro` se ignora.
 */
export function resolvePaymentModeChoice(
  configuredPaymentMode: string | null | undefined,
  cobro: unknown,
): { mode?: OrderPayMode; missingChoice?: true } {
  const configured = configuredPaymentMode?.toUpperCase();
  if (configured === "CUSTOMER_CHOICE") {
    const choice = String(cobro ?? "").trim().toLowerCase();
    if (choice === "adelantado") return { mode: "BEFORE_DELIVERY" };
    if (choice === "contra_entrega") return { mode: "CASH_ON_DELIVERY" };
    return { missingChoice: true };
  }
  const mode =
    configured === "BEFORE_DELIVERY" || configured === "CASH_ON_DELIVERY" || configured === "MANUAL"
      ? configured
      : undefined;
  return { mode };
}

export async function resolveOrderShipping(
  cfg: ShippingConfig,
  input: OrderShippingRequest,
  opts: { subtotal: number; configuredPaymentMode?: string | null },
): Promise<OrderShippingResult> {
  const enabled = enabledDeliveryTypes(cfg);
  const tipo = parseDeliveryType(input.deliveryType) ?? (enabled.length === 1 ? enabled[0] : null);
  if (!tipo) return { ok: false, code: "MISSING_TYPE" };
  if (!enabled.includes(tipo)) return { ok: false, code: "TYPE_DISABLED", deliveryType: tipo };

  const address = String(input.address ?? "").trim();
  if (tipo === "DOMICILIO" && !address) return { ok: false, code: "MISSING_ADDRESS", deliveryType: tipo };

  let courier: string | null = null;
  let agencyId: string | null = null;
  let agencyName: string | null = null;
  let agencyAddress: string | null = null;
  if (tipo === "AGENCIA") {
    const ag = cfg.types.agencia;
    const id = String(input.agencyId ?? "").trim();
    const text = String(input.agencyText ?? "").trim();
    if (id) {
      const found = await findAgencyById(id).catch(() => null);
      if (!found || !(ag.couriers as string[]).includes(found.courier)) {
        return { ok: false, code: "AGENCY_INVALID", deliveryType: tipo };
      }
      agencyId = found.id;
      agencyName = found.displayName;
      agencyAddress = found.address || null;
      courier = found.courier;
    } else if (text) {
      const all = [...(ag.couriers as string[]), ...ag.otrosCouriers];
      agencyName = text;
      courier = String(input.courier ?? "").trim() || (all.length === 1 ? all[0] : null);
    } else {
      return { ok: false, code: "MISSING_AGENCY", deliveryType: tipo };
    }
  }

  const documento = String(input.document ?? "").replace(/\s+/g, "").trim();
  if (cfg.askDocument && tipo !== "DOMICILIO" && !documento) {
    return { ok: false, code: "MISSING_DOCUMENT", deliveryType: tipo };
  }

  // «Según el modo de cobro del negocio»: vale la regla de siempre (incluida la elección del cliente).
  const rule = cfg.charge[tipo.toLowerCase() as "domicilio" | "agencia" | "recojo"];
  const pm = resolvePaymentModeChoice(opts.configuredPaymentMode, input.cobro);
  if (rule.mode === "SEGUN_MODO" && pm.missingChoice) return { ok: false, code: "MISSING_PAYMENT_CHOICE", deliveryType: tipo };

  return {
    ok: true,
    paymentMode: pm.mode,
    shipping: {
      amounts: computeOrderAmounts(cfg, { subtotal: opts.subtotal, deliveryType: tipo, paymentMode: pm.mode }),
      deliveryType: tipo,
      courier,
      agencyId,
      agencyName,
      agencyAddress,
      recipientDocument: documento || null,
      recipientPhone: String(input.recipientPhone ?? "").replace(/[^\d+]/g, "") || null,
    },
  };
}
