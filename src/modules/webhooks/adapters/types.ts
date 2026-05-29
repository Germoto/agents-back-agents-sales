/**
 * Contrato que todo adapter de webhook debe cumplir.
 * Cada proveedor externo (ValidPay, MercadoPago, etc.) tiene su propio adapter
 * que normaliza el payload al formato interno NormalizedPayment.
 */

export interface NormalizedPayment {
  /** ID único del pago en el sistema externo (usado para idempotencia) */
  externalId: string;
  /** Monto como string para comparar con DigitalSale.amountExpected (que también es string) */
  amount: string;
  /** Nombre del pagador tal como lo reporta el proveedor */
  payerName: string;
  /** Fecha/hora en que ocurrió el pago en el sistema externo */
  occurredAt: Date;
  /** Fuente del proveedor de pago: "YAPE", "PLIN", etc. (interno al payload) */
  paymentSource?: string;
  /** Texto original sin parsear (para auditoría) */
  rawText?: string;
}

export interface PaymentAdapter {
  /** Identificador del source (debe coincidir con WebhookEndpoint.source) */
  source: string;
  /** Valida y normaliza el payload crudo */
  normalize(payload: unknown): NormalizedPayment;
}
