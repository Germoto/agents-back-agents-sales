/**
 * Cliente mínimo de la API de Mercado Pago (sin SDK, fetch directo).
 *
 * Se usa con el Access Token de la aplicación MP de CADA tenant (cifrado en
 * PaymentConfig.mpAccessToken). Tres operaciones:
 *  - users/me: validar el token ("probar conexión").
 *  - checkout/preferences: crear el link de pago (Checkout Pro, init_point).
 *  - v1/payments/:id: verificar un pago notificado por webhook (fuente de
 *    verdad — el webhook de MP solo trae el id; nunca confiamos en el payload).
 */

const MP_API = "https://api.mercadopago.com";

async function mpFetch<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${MP_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      (body as { message?: string } | null)?.message ?? `Mercado Pago respondió HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export interface MpAccount {
  id: number;
  nickname: string;
  email?: string;
  site_id?: string;
}

/** Valida el token y devuelve la cuenta (probar conexión). */
export function mpGetMe(accessToken: string): Promise<MpAccount> {
  return mpFetch<MpAccount>(accessToken, "/users/me");
}

export interface MpPreference {
  id: string;
  init_point: string;
  sandbox_init_point?: string;
}

/** Crea una preference de Checkout Pro y devuelve el link de pago (init_point). */
export function mpCreatePreference(
  accessToken: string,
  opts: {
    title: string;
    amount: number;
    currency?: string;
    externalReference: string;
    notificationUrl?: string;
  },
): Promise<MpPreference> {
  return mpFetch<MpPreference>(accessToken, "/checkout/preferences", {
    method: "POST",
    body: JSON.stringify({
      items: [
        {
          title: opts.title.slice(0, 250),
          quantity: 1,
          unit_price: Number(opts.amount.toFixed(2)),
          currency_id: opts.currency ?? "PEN",
        },
      ],
      external_reference: opts.externalReference,
      ...(opts.notificationUrl ? { notification_url: opts.notificationUrl } : {}),
    }),
  });
}

export interface MpPayment {
  id: number;
  status: string; // approved | pending | rejected | ...
  transaction_amount: number;
  currency_id?: string;
  external_reference?: string | null;
  date_approved?: string | null;
  payer?: { email?: string; first_name?: string; last_name?: string };
}

/** Verifica un pago contra la API (fuente de verdad del webhook). */
export function mpGetPayment(accessToken: string, paymentId: string): Promise<MpPayment> {
  return mpFetch<MpPayment>(accessToken, `/v1/payments/${encodeURIComponent(paymentId)}`);
}

export interface MpFeeConfig {
  feeMode: string; // "TENANT" | "CUSTOMER"
  feePercent: number;
  feeFixed: number;
  feeIgv: boolean;
}

/**
 * Monto del link según quién asume la comisión. En modo CUSTOMER se hace
 * gross-up: MP cobra su % sobre el TOTAL cobrado, así que para que el tenant
 * reciba `price` neto: total = (price + fijo·igv) / (1 − %·igv).
 */
export function mpLinkAmount(price: number, cfg: MpFeeConfig): number {
  if (cfg.feeMode !== "CUSTOMER") return round2(price);
  const igv = cfg.feeIgv ? 1.18 : 1;
  const rate = (cfg.feePercent / 100) * igv;
  if (rate >= 0.9) return round2(price); // config absurda: no aplicar
  const total = (price + cfg.feeFixed * igv) / (1 - rate);
  return Math.ceil(total * 100) / 100;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
