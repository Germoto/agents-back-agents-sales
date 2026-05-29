import { PaymentAdapter } from "./types";
import { validpayAdapter } from "./validpay.adapter";

/**
 * Registry de adapters por source.
 * Para añadir un nuevo proveedor: crear el adapter e importarlo aquí.
 */
const ADAPTERS: PaymentAdapter[] = [validpayAdapter];

const adapterMap = new Map<string, PaymentAdapter>(
  ADAPTERS.map((a) => [a.source.toLowerCase(), a]),
);

export function getAdapter(source: string): PaymentAdapter | null {
  return adapterMap.get(source.toLowerCase()) ?? null;
}

export { NormalizedPayment } from "./types";
