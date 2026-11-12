/**
 * Tienda web de productos físicos (rubro comercial). Piezas puras, sin Prisma:
 * tipo de tienda, ajustes propios (StorefrontConfig.physical), qué productos
 * físicos se pueden vender online, variantes y el bloque público de entrega y cobro.
 *
 * Las reglas de envío y cobro NO viven aquí: se leen de Empresa → Envíos
 * (shipping-config.ts). La tienda solo las muestra y las aplica.
 */

import { isPlainAmount, parseAmount, planGroupOf } from "../products/product-plans";
import { courierLabel } from "../shipping/agency-search";
import { enabledDeliveryTypes, shippingOn, type DeliveryType, type ShippingConfig } from "../shipping/shipping-config";

export type StoreKind = "DIGITAL" | "PHYSICAL";

export type PhysicalSettings = {
  /** Activa la tienda de productos físicos (solo rubro comercial). */
  enabled: boolean;
  /** Permite pedidos contra entrega desde la web (sin pago en línea). */
  codEnabled: boolean;
  /** Tope de unidades por producto en un pedido. */
  maxQtyPerItem: number;
  /** Mensaje automático de WhatsApp al comprador cuando el pedido queda registrado. */
  autoConfirm: boolean;
  /** Texto del mensaje; vacío = DEFAULT_CONFIRM_MESSAGE. */
  confirmMessage: string;
  /** El agente conoce la URL de la tienda y los enlaces por producto. */
  agentShareLinks: boolean;
};

export const PHYSICAL_QTY_CAP = 99;
export const DEFAULT_MAX_QTY = 10;

/** Variables del mensaje de confirmación (el panel las ofrece como chips). */
export const CONFIRM_VARIABLES = [
  { key: "nombre", label: "Nombre del comprador" },
  { key: "pedido", label: "Código del pedido" },
  { key: "total", label: "Total del pedido" },
  { key: "pagado", label: "Monto ya pagado" },
  { key: "saldo", label: "Saldo pendiente" },
  { key: "seguimiento", label: "Enlace de seguimiento" },
] as const;

export const DEFAULT_CONFIRM_MESSAGE =
  "Hola {nombre}, recibimos tu pedido *{pedido}* de nuestra tienda web.\nTotal: {total}\nPagado: {pagado}\nSaldo: {saldo}\nPuedes seguir tu pedido aquí: {seguimiento}";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Ajustes de la tienda física con defaults (todo apagado salvo el mensaje de confirmación). */
export function physicalSettingsOf(v: unknown): PhysicalSettings {
  const o = obj(v);
  const qty = Math.round(Number(o.maxQtyPerItem));
  return {
    enabled: o.enabled === true,
    codEnabled: o.codEnabled === true,
    maxQtyPerItem: Number.isFinite(qty) && qty >= 1 ? Math.min(PHYSICAL_QTY_CAP, qty) : DEFAULT_MAX_QTY,
    autoConfirm: o.autoConfirm !== false,
    confirmMessage: typeof o.confirmMessage === "string" ? o.confirmMessage.trim().slice(0, 1000) : "",
    agentShareLinks: o.agentShareLinks === true,
  };
}
export const sanitizePhysicalSettings = physicalSettingsOf;

/**
 * Tipo de tienda: física solo si el rubro es comercial Y el dueño la activó. Así un
 * negocio comercial que ya tenía la tienda encendida no publica nada nuevo por su cuenta.
 */
export function storeKindOf(vertical: string | null | undefined, physical: unknown): StoreKind {
  return vertical === "PHYSICAL_GOODS" && physicalSettingsOf(physical).enabled ? "PHYSICAL" : "DIGITAL";
}

type ModifierGroup = { name?: string; options?: Array<{ label?: string; priceDelta?: number }> };

function modifierGroupsOf(verticalData: unknown): ModifierGroup[] {
  const groups = obj(verticalData).modifierGroups;
  return Array.isArray(groups) ? (groups as ModifierGroup[]).filter((g) => g && typeof g === "object") : [];
}

/**
 * Producto físico vendible online: precio que es solo un monto (> 0), sin planes con
 * precio ni opciones que cambien el precio (la web cobra un único precio por producto).
 */
export function isSimplePhysicalProduct(p: { price: string | null; verticalData: unknown }): boolean {
  if (!isPlainAmount(p.price) || parseAmount(p.price) <= 0) return false;
  if (planGroupOf(p.verticalData)) return false;
  return !modifierGroupsOf(p.verticalData).some((g) => (g.options ?? []).some((o) => Number(o?.priceDelta) > 0 || Number(o?.priceDelta) < 0));
}

export type StoreVariantGroup = { name: string; options: string[] };

/**
 * Grupos que el comprador elige en la ficha (talla, color…): las variantes del producto
 * más los grupos de opciones sin recargo. Solo se elige: stock y precio son del producto.
 */
export function storeVariantsOf(p: { variants: { name: string; options: unknown }[]; verticalData: unknown }): StoreVariantGroup[] {
  const out: StoreVariantGroup[] = [];
  const push = (name: unknown, options: unknown[]) => {
    const n = String(name ?? "").trim();
    const opts = Array.from(new Set(options.map((o) => String(o ?? "").trim()).filter(Boolean))).slice(0, 30);
    if (!n || !opts.length || out.some((g) => g.name.toLowerCase() === n.toLowerCase())) return;
    out.push({ name: n.slice(0, 40), options: opts.map((o) => o.slice(0, 60)) });
  };
  for (const v of p.variants) push(v.name, Array.isArray(v.options) ? v.options : []);
  for (const g of modifierGroupsOf(p.verticalData)) push(g.name, (g.options ?? []).map((o) => o?.label));
  return out.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Entrega y cobro que ofrece la web
// ---------------------------------------------------------------------------

export type WebChargeMode = "TOTAL" | "ADELANTO" | "CONTRA_ENTREGA";

export type WebChargeOption = {
  modo: WebChargeMode;
  /** Valor de `cobro` que viaja al checkout cuando el negocio deja elegir; null = no hay nada que elegir. */
  cobro: "adelantado" | "contra_entrega" | null;
  texto: string;
};

const TYPE_KEY: Record<DeliveryType, "domicilio" | "agencia" | "recojo"> = { DOMICILIO: "domicilio", AGENCIA: "agencia", RECOJO: "recojo" };

export const DELIVERY_LABELS: Record<DeliveryType, string> = {
  DOMICILIO: "Envío a domicilio",
  AGENCIA: "Envío por agencia",
  RECOJO: "Recojo en tienda",
};

export type WebChargeContext = {
  /** Modo de cobro general del negocio (Pagos): solo cuenta si la regla del tipo es «según el modo de cobro». */
  paymentMode: string | null | undefined;
  codEnabled: boolean;
  /** Hay al menos un medio de pago en línea (Mercado Pago o Yape/Plin). */
  canPayOnline: boolean;
  symbol: string;
};

/**
 * Cobros que la web ofrece para un tipo de entrega, según la regla del dueño en Envíos.
 * Contra entrega solo si la tienda lo permite; los cobros con pago, solo si hay medios
 * de pago. Lista vacía = ese tipo de entrega no se ofrece en la web.
 */
export function webChargeOptions(cfg: ShippingConfig, tipo: DeliveryType, ctx: WebChargeContext): WebChargeOption[] {
  const rule = cfg.charge[TYPE_KEY[tipo]];
  const alRecibir = tipo === "RECOJO" ? "Pagas al recoger tu pedido." : "Pagas al recibir tu pedido.";
  let options: WebChargeOption[];
  if (rule.mode === "TOTAL") options = [{ modo: "TOTAL", cobro: null, texto: "Pagas el total al hacer el pedido." }];
  else if (rule.mode === "CONTRA_ENTREGA") options = [{ modo: "CONTRA_ENTREGA", cobro: null, texto: alRecibir }];
  else if (rule.mode === "ADELANTO") {
    const cuanto =
      rule.advanceMode === "FIXED"
        ? `${ctx.symbol} ${rule.advanceValue.toFixed(2)}`
        : rule.advanceMode === "PERCENT"
          ? `el ${rule.advanceValue}%`
          : "el envío";
    options = [{ modo: "ADELANTO", cobro: null, texto: `Pagas ${cuanto} ahora para confirmar y el saldo después.` }];
  } else {
    const mode = String(ctx.paymentMode ?? "").toUpperCase();
    if (mode === "CUSTOMER_CHOICE") {
      options = [
        { modo: "TOTAL", cobro: "adelantado", texto: "Pagas el total al hacer el pedido." },
        { modo: "CONTRA_ENTREGA", cobro: "contra_entrega", texto: alRecibir },
      ];
    } else if (mode === "BEFORE_DELIVERY") options = [{ modo: "TOTAL", cobro: null, texto: "Pagas el total al hacer el pedido." }];
    else options = [{ modo: "CONTRA_ENTREGA", cobro: null, texto: alRecibir }];
  }
  return options.filter((o) => (o.modo === "CONTRA_ENTREGA" ? ctx.codEnabled : ctx.canPayOnline));
}

export type PublicDeliveryOption = {
  tipo: DeliveryType;
  label: string;
  /** Costo que se suma al total (0 si es gratis, va incluido o se paga en destino). */
  costo: number;
  costoTexto: string;
  /** Más de uno = el comprador elige cómo pagar. */
  cobros: WebChargeOption[];
  /** Solo agencia: couriers con buscador de agencias y couriers que se escriben a mano. */
  couriers?: { code: string; label: string }[];
  otrosCouriers?: string[];
  pideDocumento: boolean;
};

/** Tipos de entrega que la web puede ofrecer hoy (los que no tienen ningún cobro posible quedan fuera). */
export function publicDeliveryOptions(cfg: ShippingConfig | null, ctx: WebChargeContext): PublicDeliveryOption[] {
  if (!shippingOn(cfg)) return [];
  const money = (n: number) => `${ctx.symbol} ${n.toFixed(2)}`;
  const out: PublicDeliveryOption[] = [];
  for (const tipo of enabledDeliveryTypes(cfg)) {
    const cobros = webChargeOptions(cfg, tipo, ctx);
    if (!cobros.length) continue;
    const base = { tipo, label: DELIVERY_LABELS[tipo], cobros, pideDocumento: cfg.askDocument && tipo !== "DOMICILIO" };
    if (tipo === "DOMICILIO") {
      const cost = Math.max(0, cfg.types.domicilio.cost || 0);
      out.push({ ...base, costo: cost, costoTexto: cost > 0 ? money(cost) : "Gratis" });
    } else if (tipo === "AGENCIA") {
      const ag = cfg.types.agencia;
      const cost = ag.costMode === "FIJO" ? Math.max(0, ag.cost || 0) : 0;
      const costoTexto =
        ag.costMode === "PAGA_EN_DESTINO" ? "El flete lo pagas en la agencia al recoger" : ag.costMode === "INCLUIDO" || cost <= 0 ? "Incluido en el precio" : money(cost);
      out.push({
        ...base,
        costo: cost,
        costoTexto,
        couriers: (ag.couriers as string[]).map((c) => ({ code: c, label: courierLabel(c) })),
        otrosCouriers: ag.otrosCouriers,
      });
    } else out.push({ ...base, costo: 0, costoTexto: "Sin costo" });
  }
  return out;
}

/**
 * Por qué un tipo de entrega encendido no aparece en la web (para la lista de
 * pendientes del panel y el Copiloto); null si sí se ofrece.
 */
export function deliveryBlockedReason(cfg: ShippingConfig, tipo: DeliveryType, ctx: WebChargeContext): string | null {
  if (webChargeOptions(cfg, tipo, ctx).length) return null;
  const all = webChargeOptions(cfg, tipo, { ...ctx, codEnabled: true, canPayOnline: true });
  const soloContraEntrega = all.every((o) => o.modo === "CONTRA_ENTREGA");
  if (soloContraEntrega) return "se cobra contra entrega y la tienda no tiene encendido «Contra entrega en la web»";
  return "necesita un medio de pago en línea (Mercado Pago o Yape/Plin en Pagos)";
}
