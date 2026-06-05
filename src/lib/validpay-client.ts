/**
 * Cliente HTTP para la API de ValidPay.
 *
 * Se usa para notificar de vuelta a ValidPay cuando un pago es aprobado
 * manualmente desde el panel de sales-agents, cerrando el ciclo bidireccional
 * de la integración.
 *
 * Autenticación: Bearer JWT del usuario de ValidPay (API Key de tipo sk_live_...).
 * El apiKey se almacena por empresa en WebhookEndpoint.validpayApiKey.
 */

const VALIDPAY_API_URL =
  process.env.VALIDPAY_API_URL ?? "https://api-validpay.molanosoft.com/api";

/**
 * Marca un pago como VALIDATED en ValidPay vía el endpoint público de la API.
 * Usa X-ACCESS-TOKEN (API Key del comercio en ValidPay, tipo sk_live_...).
 * Idempotente: si ya está validado, ValidPay devuelve { ok: true, alreadyValidated: true }.
 *
 * Endpoint: PATCH /api/v1/payments/:id/validate
 * Auth:     X-ACCESS-TOKEN: sk_live_...
 *
 * @param apiKey    API Key del comercio en ValidPay (sk_live_...)
 * @param paymentId ID del pago en ValidPay (externalId guardado en PaymentReceipt)
 */
export async function validatePaymentInValidPay(
  apiKey: string,
  paymentId: string,
): Promise<void> {
  const url = `${VALIDPAY_API_URL}/v1/payments/${encodeURIComponent(paymentId)}/validate`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-ACCESS-TOKEN": apiKey,
    },
    body: JSON.stringify({
      validationNote: "Aprobado manualmente desde Sales Agents",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `ValidPay validatePayment failed: HTTP ${res.status} — ${text.slice(0, 200)}`,
    );
  }
}
