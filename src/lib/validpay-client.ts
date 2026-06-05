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
 * Marca un pago como VALIDATED en ValidPay.
 * Idempotente: si ya está validado, ValidPay devuelve { ok: true, alreadyValidated: true }.
 *
 * @param apiKey   Bearer token (sk_live_... o JWT de usuario ValidPay)
 * @param paymentId  ID del pago en ValidPay (externalId guardado en PaymentReceipt)
 */
export async function validatePaymentInValidPay(
  apiKey: string,
  paymentId: string,
): Promise<void> {
  const url = `${VALIDPAY_API_URL}/payments/${encodeURIComponent(paymentId)}/validate`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
