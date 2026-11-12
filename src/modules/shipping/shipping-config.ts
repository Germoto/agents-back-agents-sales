/**
 * Configuración de «Envíos» del rubro comercial (Company.shippingConfig).
 *
 * null o enabled=false = apagado: el negocio sigue exactamente como siempre.
 * Aquí viven la forma, la normalización (lo guardado nunca se confía a ciegas), el
 * cálculo puro de envío / total / adelanto y las frases que leen el prompt del agente,
 * el panel y el Copiloto. Sin acceso a BD: todo es puro y testeable.
 */

import { z } from "zod";

export const DELIVERY_TYPES = ["DOMICILIO", "AGENCIA", "RECOJO"] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const CHARGE_MODES = ["SEGUN_MODO", "TOTAL", "ADELANTO", "CONTRA_ENTREGA"] as const;
export type ChargeMode = (typeof CHARGE_MODES)[number];

export const ADVANCE_MODES = ["FIXED", "PERCENT", "SHIPPING"] as const;
export type AdvanceMode = (typeof ADVANCE_MODES)[number];

export const AGENCY_COST_MODES = ["INCLUIDO", "FIJO", "PAGA_EN_DESTINO"] as const;
export type AgencyCostMode = (typeof AGENCY_COST_MODES)[number];

export const PICKUP_KEY_RELEASES = ["AL_DESPACHAR", "AL_PAGAR_SALDO"] as const;
export type PickupKeyRelease = (typeof PICKUP_KEY_RELEASES)[number];

/** Eventos que pueden avisar al cliente por WhatsApp. */
export const NOTIFY_EVENTS = [
  "DESPACHADO",
  "LISTO_PARA_RECOGER",
  "ENTREGADO",
  "CANCELADO",
  "ADELANTO_RECIBIDO",
  "PAGO_COMPLETO",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const NOTIFY_EVENT_LABELS: Record<NotifyEvent, string> = {
  DESPACHADO: "Pedido despachado",
  LISTO_PARA_RECOGER: "Listo para recoger",
  ENTREGADO: "Pedido entregado",
  CANCELADO: "Pedido cancelado",
  ADELANTO_RECIBIDO: "Adelanto recibido",
  PAGO_COMPLETO: "Pago completo",
};

/** Variables disponibles en las plantillas de aviso. */
export const NOTIFY_VARIABLES = [
  "nombre",
  "pedido",
  "total",
  "pagado",
  "saldo",
  "agencia",
  "direccionAgencia",
  "guia",
  "clave",
  "courier",
  "seguimiento",
] as const;

/** Plantillas de fábrica (el dueño las edita en Empresa → Envíos → Avisos al cliente). */
export const DEFAULT_NOTIFY_MESSAGES: Record<NotifyEvent, string> = {
  DESPACHADO:
    "{Hola|Buenas} {nombre} 👋 Tu pedido *{pedido}* ya fue despachado 📦\n{courier} {agencia}\nGuía: {guia}\nSaldo pendiente: {saldo}",
  LISTO_PARA_RECOGER:
    "{Hola|Buenas} {nombre} 🙌 Tu pedido *{pedido}* ya está listo para recoger.\n📍 {agencia}\n{direccionAgencia}\nClave de recojo: {clave}",
  ENTREGADO: "{Gracias|Muchas gracias} {nombre} 🙏 Tu pedido *{pedido}* figura como entregado. ¡Que lo disfrutes!",
  CANCELADO: "Hola {nombre}, tu pedido *{pedido}* fue cancelado. Si fue un error, escríbenos y lo vemos.",
  ADELANTO_RECIBIDO:
    "{Listo|Perfecto} {nombre} ✅ Recibimos tu adelanto de {pagado} por el pedido *{pedido}*. Saldo pendiente: {saldo}",
  PAGO_COMPLETO: "{Listo|Perfecto} {nombre} ✅ Tu pedido *{pedido}* quedó pagado por completo ({total}).",
};

const money = z.coerce.number().min(0).max(999999).default(0);

const chargeRuleSchema = z.object({
  mode: z.enum(CHARGE_MODES).default("SEGUN_MODO"),
  advanceMode: z.enum(ADVANCE_MODES).default("PERCENT"),
  advanceValue: z.coerce.number().min(0).max(999999).default(50),
});
export type ChargeRule = z.infer<typeof chargeRuleSchema>;

const notificationSchema = z.object({
  enabled: z.boolean().default(false),
  message: z.string().trim().max(1000).default(""),
});

const notificationsShape = Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, notificationSchema.optional()])) as Record<
  NotifyEvent,
  z.ZodOptional<typeof notificationSchema>
>;

export const shippingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  types: z
    .object({
      domicilio: z.object({ enabled: z.boolean().default(false), cost: money }).prefault({}),
      agencia: z
        .object({
          enabled: z.boolean().default(false),
          // Couriers con catálogo propio (hoy solo SHALOM).
          couriers: z.array(z.string().trim().min(1).max(30)).max(5).default(["SHALOM"]),
          // Otras couriers que el negocio usa: la agencia se anota como texto libre.
          otrosCouriers: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
          costMode: z.enum(AGENCY_COST_MODES).default("PAGA_EN_DESTINO"),
          cost: money,
        })
        .prefault({}),
      recojo: z.object({ enabled: z.boolean().default(false) }).prefault({}),
    })
    .prefault({}),
  askDocument: z.boolean().default(true),
  charge: z
    .object({
      domicilio: chargeRuleSchema.prefault({}),
      agencia: chargeRuleSchema.prefault({}),
      recojo: chargeRuleSchema.prefault({}),
    })
    .prefault({}),
  pickupKeyRelease: z.enum(PICKUP_KEY_RELEASES).default("AL_PAGAR_SALDO"),
  notifications: z.object(notificationsShape).prefault({}),
});

export type ShippingConfig = Omit<z.infer<typeof shippingConfigSchema>, "notifications"> & {
  notifications: Record<NotifyEvent, { enabled: boolean; message: string }>;
};

/**
 * Lo guardado (o lo que manda el panel) → config completa. null si viene vacío o roto.
 * Los avisos sin mensaje propio muestran la plantilla de fábrica.
 */
export function normalizeShippingConfig(raw: unknown): ShippingConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = shippingConfigSchema.safeParse(raw);
  if (!parsed.success) return null;
  const notifications = {} as ShippingConfig["notifications"];
  for (const ev of NOTIFY_EVENTS) {
    const n = parsed.data.notifications?.[ev];
    notifications[ev] = { enabled: !!n?.enabled, message: n?.message?.trim() || DEFAULT_NOTIFY_MESSAGES[ev] };
  }
  return { ...parsed.data, notifications };
}

/** Config "de fábrica" (todo apagado) para pintar el panel cuando aún no hay nada guardado. */
export function defaultShippingConfig(): ShippingConfig {
  return normalizeShippingConfig({})!;
}

/** ¿El negocio tiene «Envíos» encendido? Compuerta de TODA la lógica nueva. */
export function shippingOn(cfg: ShippingConfig | null | undefined): cfg is ShippingConfig {
  return !!cfg?.enabled;
}

const TYPE_KEY: Record<DeliveryType, "domicilio" | "agencia" | "recojo"> = {
  DOMICILIO: "domicilio",
  AGENCIA: "agencia",
  RECOJO: "recojo",
};

/** Tipos de entrega que el negocio ofrece. */
export function enabledDeliveryTypes(cfg: ShippingConfig): DeliveryType[] {
  return DELIVERY_TYPES.filter((t) => cfg.types[TYPE_KEY[t]].enabled);
}

/** Texto libre del modelo/panel → tipo de entrega. null si no se entiende. */
export function parseDeliveryType(v: unknown): DeliveryType | null {
  const s = String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .trim();
  if (!s) return null;
  if (s.includes("AGENCIA") || s.includes("COURIER") || s.includes("SHALOM")) return "AGENCIA";
  if (s.includes("RECOJO") || s.includes("TIENDA") || s.includes("RETIRO") || s.includes("PICKUP")) return "RECOJO";
  if (s.includes("DOMICILIO") || s.includes("DELIVERY") || s.includes("CASA") || s.includes("DIRECCION")) return "DOMICILIO";
  return null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type PaymentModeLike = "BEFORE_DELIVERY" | "CASH_ON_DELIVERY" | "MANUAL" | "CUSTOMER_CHOICE" | string | null | undefined;

export interface OrderAmounts {
  subtotal: number;
  shipping: number;
  total: number;
  /** Adelanto mínimo para confirmar el pedido. 0 = no se cobra nada antes. total = pago completo. */
  advance: number;
  /** Regla efectiva tras resolver SEGUN_MODO. */
  chargeMode: Exclude<ChargeMode, "SEGUN_MODO">;
  /** El flete lo paga el cliente a la courier al recoger (no entra al total). */
  shippingPaidAtDestination: boolean;
}

/**
 * Envío, total y adelanto de un pedido según la configuración. Puro.
 * SEGUN_MODO respeta el modo de cobro general del negocio (Pagos): antes de la entrega
 * = total; contra entrega / manual / el cliente elige = nada por adelantado.
 */
export function computeOrderAmounts(
  cfg: ShippingConfig,
  input: { subtotal: number; deliveryType: DeliveryType; paymentMode?: PaymentModeLike },
): OrderAmounts {
  const subtotal = round2(Math.max(0, input.subtotal || 0));
  let shipping = 0;
  let shippingPaidAtDestination = false;
  if (input.deliveryType === "DOMICILIO") shipping = cfg.types.domicilio.cost;
  else if (input.deliveryType === "AGENCIA") {
    if (cfg.types.agencia.costMode === "FIJO") shipping = cfg.types.agencia.cost;
    else if (cfg.types.agencia.costMode === "PAGA_EN_DESTINO") shippingPaidAtDestination = true;
  }
  shipping = round2(Math.max(0, shipping || 0));
  const total = round2(subtotal + shipping);

  const rule = cfg.charge[TYPE_KEY[input.deliveryType]];
  let chargeMode: OrderAmounts["chargeMode"];
  if (rule.mode === "SEGUN_MODO") {
    chargeMode = String(input.paymentMode ?? "").toUpperCase() === "BEFORE_DELIVERY" ? "TOTAL" : "CONTRA_ENTREGA";
  } else chargeMode = rule.mode;

  let advance = 0;
  if (chargeMode === "TOTAL") advance = total;
  else if (chargeMode === "ADELANTO") {
    if (rule.advanceMode === "FIXED") advance = rule.advanceValue;
    else if (rule.advanceMode === "PERCENT") advance = (total * Math.min(100, rule.advanceValue)) / 100;
    else advance = shipping;
  }
  advance = round2(Math.min(total, Math.max(0, advance)));
  return { subtotal, shipping, total, advance, chargeMode, shippingPaidAtDestination };
}

/** Frase corta de la regla de cobro de un tipo de entrega (prompt, panel y Copiloto). */
export function describeChargeRule(rule: ChargeRule, symbol: string): string {
  if (rule.mode === "TOTAL") return "se paga el total antes de enviar";
  if (rule.mode === "CONTRA_ENTREGA") return "no se cobra nada por adelantado, se paga al recibir";
  if (rule.mode === "ADELANTO") {
    if (rule.advanceMode === "FIXED") return `adelanto de ${symbol} ${rule.advanceValue.toFixed(2)} para confirmar y el saldo después`;
    if (rule.advanceMode === "PERCENT") return `adelanto del ${rule.advanceValue}% para confirmar y el saldo después`;
    return "se adelanta el costo del envío para confirmar y el saldo después";
  }
  return "según el modo de cobro general del negocio (Pagos)";
}

/**
 * Frases interpretadas de la configuración: una por tipo de entrega encendido, más
 * DNI, clave y avisos. Las usan el cuadro «Con esta configuración:» del panel, el
 * Copiloto (ver_configuracion) y las líneas de capacidad del prompt del agente.
 */
export function describeShippingConfig(cfg: ShippingConfig | null, symbol: string): string[] {
  if (!shippingOn(cfg)) return ["Envíos apagado: los pedidos se registran como siempre, sin costo de envío en el total ni adelanto."];
  const out: string[] = [];
  const t = cfg.types;
  if (t.domicilio.enabled) {
    const cost = t.domicilio.cost > 0 ? `suma ${symbol} ${t.domicilio.cost.toFixed(2)} al total` : "sin costo adicional";
    out.push(`Entrega a domicilio: ${cost}; ${describeChargeRule(cfg.charge.domicilio, symbol)}.`);
  }
  if (t.agencia.enabled) {
    const couriers = [...t.agencia.couriers.map((c) => (c === "SHALOM" ? "Shalom (agencias con buscador)" : c)), ...t.agencia.otrosCouriers];
    const cost =
      t.agencia.costMode === "FIJO"
        ? `el flete (${symbol} ${t.agencia.cost.toFixed(2)}) se suma al total`
        : t.agencia.costMode === "INCLUIDO"
          ? "el flete está incluido en el precio"
          : "el flete lo paga el cliente a la courier al recoger";
    out.push(`Envío por agencia (${couriers.join(", ") || "courier"}): ${cost}; ${describeChargeRule(cfg.charge.agencia, symbol)}.`);
  }
  if (t.recojo.enabled) out.push(`Recojo en tienda: ${describeChargeRule(cfg.charge.recojo, symbol)}.`);
  if (!out.length) out.push("Envíos encendido pero sin ningún tipo de entrega activo: actívalo para que el agente pueda registrar pedidos con envío.");
  if (t.agencia.enabled || t.recojo.enabled) {
    out.push(cfg.askDocument ? "Se pide el DNI de quien recoge." : "No se pide DNI de quien recoge.");
  }
  if (t.agencia.enabled) {
    out.push(
      cfg.pickupKeyRelease === "AL_PAGAR_SALDO"
        ? "La clave de recojo se entrega al cliente solo cuando el pedido está pagado por completo."
        : "La clave de recojo se entrega al cliente apenas se despacha el pedido.",
    );
  }
  const on = NOTIFY_EVENTS.filter((e) => cfg.notifications[e].enabled).map((e) => NOTIFY_EVENT_LABELS[e]);
  out.push(on.length ? `Avisos automáticos al cliente: ${on.join(", ")}.` : "Avisos automáticos al cliente: ninguno encendido.");
  return out;
}
