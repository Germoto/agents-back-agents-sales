/**
 * Dinero de un pedido con «Envíos»: total, adelanto, pagado y saldo.
 *
 * Compuerta única de toda la lógica nueva: un pedido solo entra aquí si tiene
 * `totalAmount`, y solo lo tiene si el negocio encendió «Envíos» al registrarlo.
 * Los pedidos "de siempre" (totalAmount null) siguen por markOrderPaid.
 */

import { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";

const EPS = 0.005;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const toNum = (d: Prisma.Decimal | number | null | undefined): number | null => (d == null ? null : Number(d));
export const toDec = (n: number) => new Prisma.Decimal(round2(n).toFixed(2));

/** Estados en los que el agente todavía puede cobrar algo del pedido. */
export const COLLECTIBLE_STATUSES: OrderStatus[] = [
  "PENDIENTE_PAGO",
  "PEDIDO_REGISTRADO",
  "EN_COORDINACION",
  "DESPACHADO",
  "LISTO_PARA_RECOGER",
];
/** Estados previos al despacho: los únicos desde los que un pago mueve el estado logístico. */
const PRE_DISPATCH_STATUSES: OrderStatus[] = ["PENDIENTE_PAGO", "PEDIDO_REGISTRADO", "EN_COORDINACION"];

export type PaymentKind = "ADELANTO" | "SALDO" | "TOTAL" | "OTRO";
export type PaymentSource = "AGENTE" | "PANEL" | "COPILOTO" | "MERCADOPAGO" | "WEB";

type MoneyFields = {
  totalAmount: Prisma.Decimal | number | null;
  advanceAmount: Prisma.Decimal | number | null;
  paidAmount: Prisma.Decimal | number | null;
};

export interface OrderMoney {
  total: number;
  advance: number;
  paid: number;
  /** Lo que falta para completar el total (nunca negativo). */
  balance: number;
  /** Lo que falta para cubrir el adelanto mínimo (0 = ya cubierto o no se pidió). */
  advanceMin: number;
  /** Lo que toca cobrar ahora: el adelanto que falta o, cubierto, el saldo. */
  now: number;
  phase: "ADELANTO" | "SALDO";
}

/** Puro. null si el pedido no maneja montos (pedido de siempre). */
export function moneyOf(order: MoneyFields): OrderMoney | null {
  const total = toNum(order.totalAmount);
  if (total == null) return null;
  const paid = round2(toNum(order.paidAmount) ?? 0);
  const advance = round2(Math.min(total, toNum(order.advanceAmount) ?? 0));
  const balance = round2(Math.max(0, total - paid));
  const advanceMin = round2(Math.max(0, Math.min(balance, advance - paid)));
  const phase = advanceMin > EPS ? "ADELANTO" : "SALDO";
  return { total, advance, paid, balance, advanceMin, now: phase === "ADELANTO" ? advanceMin : balance, phase };
}

/**
 * ¿Un monto leído de un comprobante sirve para este pedido? Con adelanto pendiente:
 * desde el adelanto mínimo hasta el saldo. Con el adelanto cubierto: cualquier monto
 * hasta el saldo.
 */
export function acceptsAmount(money: OrderMoney, amount: number): boolean {
  if (!(amount > 0) || money.balance <= EPS) return false;
  if (amount > money.balance + EPS) return false;
  return money.phase === "ADELANTO" ? amount >= money.advanceMin - EPS : true;
}

const DUE_SELECT = {
  id: true,
  orderCode: true,
  status: true,
  total: true,
  deliveryType: true,
  courier: true,
  agencyName: true,
  agencyAddress: true,
  trackingCode: true,
  pickupKey: true,
  subtotalAmount: true,
  shippingAmount: true,
  totalAmount: true,
  advanceAmount: true,
  paidAmount: true,
  paymentStatus: true,
  source: true,
  createdAt: true,
} satisfies Prisma.OrderSelect;

export type CurrentOrder = Prisma.OrderGetPayload<{ select: typeof DUE_SELECT }> & { money: OrderMoney };

/**
 * Pedido vigente del cliente: el más reciente con montos que no esté cancelado ni
 * entregado. null para clientes sin pedido de este tipo (todo sigue como siempre).
 */
export async function currentOrderFor(companyId: string, customerId: string): Promise<CurrentOrder | null> {
  const order = await prisma.order.findFirst({
    where: { companyId, customerId, totalAmount: { not: null }, status: { notIn: ["CANCELADO", "ENTREGADO"] } },
    orderBy: { createdAt: "desc" },
    select: DUE_SELECT,
  });
  if (!order) return null;
  const money = moneyOf(order);
  return money ? { ...order, money } : null;
}

export interface OrderDue extends OrderMoney {
  orderId: string;
  orderCode: string;
  status: OrderStatus;
}

/**
 * Lo que toca cobrarle AHORA al cliente por su pedido abierto. null si no hay pedido
 * con montos, si ya está pagado o si su estado ya no admite cobro desde el chat.
 */
export async function orderDueFor(companyId: string, customerId: string): Promise<OrderDue | null> {
  const order = await prisma.order.findFirst({
    where: { companyId, customerId, totalAmount: { not: null }, status: { in: COLLECTIBLE_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: DUE_SELECT,
  });
  if (!order) return null;
  const money = moneyOf(order);
  if (!money || money.balance <= EPS) return null;
  return { ...money, orderId: order.id, orderCode: order.orderCode, status: order.status };
}

/**
 * Pedido al que se puede aplicar un comprobante aprobado a mano: el ÚNICO pedido del
 * cliente con saldo y en estado cobrable. Con varios (o ninguno) devuelve null y el
 * dueño lo registra desde Pedidos, para no acreditar al pedido equivocado.
 */
export async function singleOpenOrderFor(companyId: string, customerId: string): Promise<OrderDue | null> {
  const orders = await prisma.order.findMany({
    where: { companyId, customerId, totalAmount: { not: null }, status: { in: COLLECTIBLE_STATUSES } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: DUE_SELECT,
  });
  const open = orders
    .map((o) => ({ o, money: moneyOf(o) }))
    .filter((x): x is { o: (typeof orders)[number]; money: OrderMoney } => !!x.money && x.money.balance > EPS);
  if (open.length !== 1) return null;
  const { o, money } = open[0];
  return { ...money, orderId: o.id, orderCode: o.orderCode, status: o.status };
}

export interface ApplyPaymentInput {
  companyId: string;
  orderId: string;
  amount: number;
  source: PaymentSource;
  kind?: PaymentKind;
  method?: string | null;
  /** Comprobante que respalda el pago: hace idempotente el registro. */
  receiptId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

export interface ApplyPaymentResult {
  /** true = ese comprobante ya estaba aplicado a un pedido; no se contó de nuevo. */
  already: boolean;
  orderId: string;
  orderCode: string;
  status: OrderStatus;
  kind: PaymentKind;
  amount: number;
  money: OrderMoney;
  fullyPaid: boolean;
}

/**
 * Registra un pago del pedido. Lo pagado se recalcula como SUMA de pagos dentro de la
 * transacción, así un reintento nunca cuenta doble. Deja paymentStatus en PAGO_PARCIAL
 * o PAGADO y solo mueve el estado logístico desde los estados previos al despacho.
 * Devuelve null si el pedido no existe o no maneja montos.
 */
export async function applyOrderPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult | null> {
  const amount = round2(Number(input.amount));
  if (!(amount > 0)) throw new AppError("El monto del pago debe ser mayor a 0", 400);

  const result = await prisma.$transaction(async (tx) => {
    // Candado de fila: dos pagos simultáneos del mismo pedido se aplican en serie.
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id"::text = ${input.orderId} AND "companyId"::text = ${input.companyId} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: input.orderId, companyId: input.companyId },
      select: { id: true, orderCode: true, status: true, totalAmount: true, advanceAmount: true, paidAmount: true },
    });
    if (!order) return null;
    const before = moneyOf(order);
    if (!before) return null;

    if (input.receiptId) {
      const dup = await tx.orderPayment.findUnique({ where: { receiptId: input.receiptId } });
      if (dup) {
        return {
          already: true,
          order,
          kind: dup.kind as PaymentKind,
          amount: Number(dup.amount),
          money: before,
          previousStatus: order.status,
        };
      }
    }

    const kind: PaymentKind =
      input.kind ??
      (amount >= before.balance - EPS ? (before.paid > EPS ? "SALDO" : "TOTAL") : before.advanceMin > EPS ? "ADELANTO" : "OTRO");

    await tx.orderPayment.create({
      data: {
        companyId: input.companyId,
        orderId: order.id,
        amount: toDec(amount),
        kind,
        method: input.method?.trim() || null,
        source: input.source,
        receiptId: input.receiptId ?? null,
        note: input.note?.trim() || null,
        createdBy: input.createdBy ?? null,
      },
    });
    const sum = await tx.orderPayment.aggregate({ where: { orderId: order.id }, _sum: { amount: true } });
    const paid = round2(Number(sum._sum.amount ?? 0));
    const money = moneyOf({ ...order, paidAmount: paid })!;
    const fullyPaid = money.balance <= EPS;
    await tx.order.update({
      where: { id: order.id },
      data: { paidAmount: toDec(paid), paymentStatus: fullyPaid ? "PAGADO" : "PAGO_PARCIAL" },
    });
    if (input.receiptId) {
      // Enlace suelto del comprobante con su pedido (lo usa el detalle del pedido).
      await tx.paymentReceipt.updateMany({
        where: { id: input.receiptId, companyId: input.companyId },
        data: { orderId: order.id },
      });
    }
    return { already: false, order, kind, amount, money, previousStatus: order.status };
  });
  if (!result) return null;

  let status = result.order.status;
  if (!result.already && PRE_DISPATCH_STATUSES.includes(status)) {
    const fullyPaid = result.money.balance <= EPS;
    // Import diferido: orders.service importa este módulo.
    const { updateOrderStatus } = await import("./orders.service");
    if (fullyPaid) {
      // PAGADO descuenta stock (updateOrderStatus) igual que un pedido de siempre.
      const u = await updateOrderStatus(input.companyId, result.order.id, "PAGADO", {
        changedBy: input.createdBy ?? "sistema",
        note: "Pago completo",
      }).catch(() => null);
      if (u) status = u.status;
    } else if (status === "PENDIENTE_PAGO" && result.money.advanceMin <= EPS) {
      // Adelanto cubierto: el pedido queda confirmado, a la espera del despacho.
      const u = await updateOrderStatus(input.companyId, result.order.id, "PEDIDO_REGISTRADO", {
        changedBy: input.createdBy ?? "sistema",
        note: "Adelanto recibido",
      }).catch(() => null);
      if (u) status = u.status;
    }
  }
  if (!result.already && status === result.order.status) {
    // Sin cambio de estado no hubo evento: avisar al panel para que refresque montos.
    socketService.emitToCompany(input.companyId, SOCKET_EVENTS.ORDER_NEW, {
      id: result.order.id,
      orderCode: result.order.orderCode,
      status,
    });
  }

  return {
    already: result.already,
    orderId: result.order.id,
    orderCode: result.order.orderCode,
    status,
    kind: result.kind,
    amount: result.amount,
    money: result.money,
    fullyPaid: result.money.balance <= EPS,
  };
}

const AMOUNT_KEYS = ["subtotalAmount", "shippingAmount", "totalAmount", "advanceAmount", "paidAmount"] as const;

/**
 * Montos como número (no Decimal) y saldo calculado, hacia el panel y el Copiloto.
 * En pedidos de siempre los montos van null y balanceAmount también.
 */
export function mapOrder<T extends Partial<Record<(typeof AMOUNT_KEYS)[number], Prisma.Decimal | number | null>>>(order: T) {
  const out: Record<string, unknown> = { ...order };
  for (const k of AMOUNT_KEYS) out[k] = toNum(order[k] ?? null);
  const money = moneyOf({
    totalAmount: order.totalAmount ?? null,
    advanceAmount: order.advanceAmount ?? null,
    paidAmount: order.paidAmount ?? null,
  });
  out.balanceAmount = money ? money.balance : null;
  if ("payments" in out && Array.isArray(out.payments)) {
    out.payments = (out.payments as Array<{ amount: Prisma.Decimal | number }>).map((p) => ({ ...p, amount: Number(p.amount) }));
  }
  return out as Omit<T, (typeof AMOUNT_KEYS)[number] | "payments"> & {
    subtotalAmount: number | null;
    shippingAmount: number | null;
    totalAmount: number | null;
    advanceAmount: number | null;
    paidAmount: number | null;
    balanceAmount: number | null;
  } & (T extends { payments: Array<infer P> } ? { payments: Array<Omit<P, "amount"> & { amount: number }> } : unknown);
}
