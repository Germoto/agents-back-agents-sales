/**
 * Carrito multi-producto del agente. Un carrito OPEN por cliente; al cobrar se
 * marca CHECKED_OUT y sus productIds se usan para cerrar el PaymentReceipt.
 */

import { prisma } from "../../lib/prisma";

export interface CartLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceText: string | null;
  unitPrice: number;
}

export interface CartSummary {
  cartId: string;
  items: CartLine[];
  total: number;
  totalText: string;
  productIds: string[];
}

const CURRENCY = "S/";

function parsePrice(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(n: number): string {
  return `${CURRENCY} ${n.toFixed(2)}`;
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
): Promise<CartSummary> {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId, active: true },
    select: { id: true, price: true },
  });
  if (!product) throw new Error("Producto no encontrado o inactivo");

  const cartId = await getOpenCart(companyId, customerId);
  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId, productId } },
    update: { quantity: { increment: quantity }, unitPriceText: product.price },
    create: { cartId, productId, quantity, unitPriceText: product.price },
  });
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
        select: {
          productId: true,
          quantity: true,
          unitPriceText: true,
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
    return {
      productId: it.productId,
      name: it.product.name,
      quantity: it.quantity,
      unitPriceText: it.unitPriceText ?? it.product.price,
      unitPrice,
    };
  });
  const total = items.reduce((acc, it) => acc + it.unitPrice * it.quantity, 0);

  return {
    cartId: cart.id,
    items,
    total,
    totalText: formatMoney(total),
    productIds: items.map((it) => it.productId),
  };
}

/** Marca el carrito OPEN como CHECKED_OUT. Llamar tras aprobar el pago. */
export async function checkoutCart(companyId: string, customerId: string, totalText: string) {
  await prisma.cart.updateMany({
    where: { companyId, customerId, status: "OPEN" },
    data: { status: "CHECKED_OUT", totalText },
  });
}

export function renderCartText(summary: CartSummary): string {
  if (!summary.items.length) return "Tu carrito está vacío.";
  const lines = summary.items.map(
    (it) => `• ${it.name} x${it.quantity} — ${formatMoney(it.unitPrice * it.quantity)}`,
  );
  lines.push(`\n*Total: ${summary.totalText}*`);
  return lines.join("\n");
}
