/**
 * Carrito multi-producto del agente. Un carrito OPEN por cliente; al cobrar/
 * registrar se marca CHECKED_OUT.
 *
 * Soporta MODIFICADORES con price-delta (restaurante: "extra queso +S/2"):
 * el mismo producto puede aparecer en varias líneas con distintos modificadores.
 * El precio de cada línea = precio base + suma de deltas de sus modificadores.
 */

import { prisma } from "../../lib/prisma";

export interface ChosenModifier {
  group: string;
  option: string;
  priceDelta: number;
}

export interface ModifierInput {
  group: string;
  option: string;
}

export interface CartLine {
  itemId: string;
  productId: string;
  name: string;
  quantity: number;
  unitPriceText: string | null;
  unitPrice: number;
  modifiers: ChosenModifier[];
}

export interface CartSummary {
  cartId: string;
  items: CartLine[];
  total: number;
  totalText: string;
  productIds: string[];
}

const CURRENCY = "S/";

export function parsePrice(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(n: number): string {
  return `${CURRENCY} ${n.toFixed(2)}`;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Resuelve los modificadores elegidos contra verticalData.modifierGroups y suma sus deltas. */
function resolveModifiers(
  verticalData: unknown,
  inputs: ModifierInput[] | undefined,
): { chosen: ChosenModifier[]; delta: number } {
  const chosen: ChosenModifier[] = [];
  let delta = 0;
  if (!inputs?.length) return { chosen, delta };
  const groups = ((verticalData as any)?.modifierGroups ?? []) as Array<{
    name?: string;
    options?: Array<{ label?: string; priceDelta?: number }>;
  }>;
  for (const inp of inputs) {
    if (!inp?.option) continue;
    const g = groups.find((x) => x.name && norm(x.name) === norm(inp.group ?? ""));
    let priceDelta = 0;
    if (g) {
      const o = (g.options ?? []).find((op) => op.label && norm(op.label) === norm(inp.option));
      if (o) priceDelta = Number(o.priceDelta) || 0;
    }
    chosen.push({ group: inp.group ?? "", option: inp.option, priceDelta });
    delta += priceDelta;
  }
  return { chosen, delta };
}

async function getOpenCart(companyId: string, customerId: string) {
  const existing = await prisma.cart.findFirst({
    where: { companyId, customerId, status: "OPEN" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.cart.create({
    data: { companyId, customerId, status: "OPEN" },
    select: { id: true },
  });
  return created.id;
}

export async function addToCart(
  companyId: string,
  customerId: string,
  productId: string,
  quantity = 1,
  modifiers?: ModifierInput[],
): Promise<CartSummary> {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId, active: true },
    select: { id: true, price: true, verticalData: true },
  });
  if (!product) throw new Error("Producto no encontrado o inactivo");

  const cartId = await getOpenCart(companyId, customerId);
  const { chosen, delta } = resolveModifiers(product.verticalData, modifiers);
  const unit = parsePrice(product.price) + delta;
  const unitPriceText = formatMoney(unit);
  const qty = Math.max(1, quantity || 1);

  // Buscar una línea existente del mismo producto con los MISMOS modificadores
  const lines = await prisma.cartItem.findMany({ where: { cartId, productId } });
  const key = JSON.stringify(chosen);
  const match = lines.find((l) => JSON.stringify((l.variantChoices as unknown) ?? []) === key);

  if (match) {
    await prisma.cartItem.update({
      where: { id: match.id },
      data: { quantity: { increment: qty }, unitPriceText },
    });
  } else {
    await prisma.cartItem.create({
      data: {
        cartId,
        productId,
        quantity: qty,
        unitPriceText,
        variantChoices: chosen as unknown as object,
      },
    });
  }
  return summarizeCart(companyId, customerId);
}

export async function removeFromCart(
  companyId: string,
  customerId: string,
  productId: string,
): Promise<CartSummary> {
  const cart = await prisma.cart.findFirst({
    where: { companyId, customerId, status: "OPEN" },
    select: { id: true },
  });
  if (cart) {
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id, productId } });
  }
  return summarizeCart(companyId, customerId);
}

export async function summarizeCart(
  companyId: string,
  customerId: string,
): Promise<CartSummary> {
  const cart = await prisma.cart.findFirst({
    where: { companyId, customerId, status: "OPEN" },
    select: {
      id: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          productId: true,
          quantity: true,
          unitPriceText: true,
          variantChoices: true,
          product: { select: { name: true, price: true } },
        },
      },
    },
  });

  if (!cart) {
    return { cartId: "", items: [], total: 0, totalText: formatMoney(0), productIds: [] };
  }

  const items: CartLine[] = cart.items.map((it) => {
    const unitPrice = parsePrice(it.unitPriceText ?? it.product.price);
    const modifiers = (Array.isArray(it.variantChoices) ? it.variantChoices : []) as unknown as ChosenModifier[];
    return {
      itemId: it.id,
      productId: it.productId,
      name: it.product.name,
      quantity: it.quantity,
      unitPriceText: it.unitPriceText ?? it.product.price,
      unitPrice,
      modifiers,
    };
  });
  const total = items.reduce((acc, it) => acc + it.unitPrice * it.quantity, 0);

  return {
    cartId: cart.id,
    items,
    total,
    totalText: formatMoney(total),
    productIds: Array.from(new Set(items.map((it) => it.productId))),
  };
}

/** Marca el carrito OPEN como CHECKED_OUT. Llamar tras aprobar el pago / registrar el pedido. */
export async function checkoutCart(companyId: string, customerId: string, totalText: string) {
  await prisma.cart.updateMany({
    where: { companyId, customerId, status: "OPEN" },
    data: { status: "CHECKED_OUT", totalText },
  });
}

function lineLabel(it: CartLine): string {
  const mods = it.modifiers?.length
    ? ` (${it.modifiers.map((m) => m.option).join(", ")})`
    : "";
  return `${it.quantity}x ${it.name}${mods}`;
}

export function renderCartText(summary: CartSummary): string {
  if (!summary.items.length) return "Tu carrito está vacío.";
  const lines = summary.items.map(
    (it) => `• ${lineLabel(it)} — ${formatMoney(it.unitPrice * it.quantity)}`,
  );
  lines.push(`\n*Total: ${summary.totalText}*`);
  return lines.join("\n");
}

/** Itemizado para el pedido (notas del Order). */
export function renderCartForOrder(summary: CartSummary): string {
  const lines = summary.items.map((it) => `- ${lineLabel(it)} (${formatMoney(it.unitPrice * it.quantity)})`);
  lines.push(`Total: ${summary.totalText}`);
  return lines.join("\n");
}
