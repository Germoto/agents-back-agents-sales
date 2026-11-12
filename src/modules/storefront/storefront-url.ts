import { env } from "../../config/env";

/** URL pública de la tienda de un slug (subdominio en prod; path en desarrollo). */
export function storeUrl(slug: string): string {
  if (env.STORE_DOMAIN) return `https://${slug}.${env.STORE_DOMAIN}`;
  const base = (env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  return `${base}/tienda/${slug}`;
}

/** Página pública de un pedido de la tienda (pago y seguimiento). */
export function storeOrderUrl(slug: string, storeOrderId: string, accessToken: string): string {
  return `${storeUrl(slug)}/gracias?o=${storeOrderId}&t=${accessToken}`;
}
