/**
 * Moneda del negocio (nivel EMPRESA, Company.currency). PEN (S/) por defecto;
 * USD ($) opcional. Todo texto de dinero que ve el cliente o el panel debe
 * derivar su símbolo de aquí — nunca hardcodear "S/".
 */

export const SUPPORTED_CURRENCIES = ["PEN", "USD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const SYMBOLS: Record<string, string> = { PEN: "S/", USD: "$" };

/** Símbolo de la moneda ("S/" | "$"); default S/ para cualquier valor raro. */
export function symbolFor(currency?: string | null): string {
  return SYMBOLS[(currency ?? "PEN").toUpperCase()] ?? "S/";
}

/** Normaliza a una moneda soportada (default PEN). */
export function normalizeCurrency(currency?: string | null): Currency {
  const c = (currency ?? "").toUpperCase();
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(c) ? (c as Currency) : "PEN";
}

/** "S/ 10.00" | "$ 10.00" */
export function formatAmount(n: number, currency?: string | null): string {
  return `${symbolFor(currency)} ${n.toFixed(2)}`;
}
