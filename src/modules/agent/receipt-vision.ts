/**
 * Lectura del comprobante de pago (Yape/Plin) con visión. Hace UNA llamada
 * aislada a OpenAI (multimodal) y devuelve datos estructurados. La constancia
 * NO muestra el nombre de quien paga (muestra el destino = nuestro titular);
 * lo confiable es el MONTO, la HORA y, en Yape→Yape, un CÓDIGO DE SEGURIDAD
 * (suele aparecer como "código: 123"). No se infiere el nombre del pagador.
 */

export interface ReceiptData {
  amountText: string | null;
  time: string | null;
  /** N° de operación: está en TODOS los comprobantes (Yape/Plin). Llave principal. */
  operationNumber: string | null;
  /** Código de seguridad (solo Yape→Yape, 3 dígitos). Llave secundaria. */
  securityCode: string | null;
}

const SYSTEM =
  "Eres un lector de comprobantes de pago de Yape y Plin (Perú). Devuelves SOLO JSON. " +
  "Lee la imagen y extrae: el monto pagado (amountText, ej. 'S/ 5.00'); la hora/fecha que aparezca " +
  "(time, texto tal cual); el CÓDIGO DE SEGURIDAD (securityCode), que aparece SOLO en transferencias " +
  "Yape→Yape, rotulado 'código de seguridad' o 'cód' (suele ser de 3 dígitos, ej. 'código de seguridad: 934' " +
  "→ devuelve '934'); si NO aparece un código de seguridad, securityCode = null. Además, el NÚMERO DE " +
  "OPERACIÓN (operationNumber, el numerito largo rotulado 'Nro de operación'). " +
  "NO inventes ni infieras el nombre de quien paga: la constancia muestra al DESTINATARIO (a quién se le pagó), " +
  "no al pagador. Si un dato no aparece, usa null.";

const SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "receipt",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["amountText", "time", "operationNumber", "securityCode"],
      properties: {
        amountText: { type: ["string", "null"] },
        time: { type: ["string", "null"] },
        operationNumber: { type: ["string", "null"] },
        securityCode: { type: ["string", "null"] },
      },
    },
  },
};

/** Lee un comprobante. Devuelve null si falla (best-effort, no rompe el turno). */
export async function readReceiptImage(
  apiKey: string,
  model: string,
  imageUrl: string,
): Promise<ReceiptData | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: SCHEMA,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Lee este comprobante y devuelve el JSON pedido." },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      console.warn(`[receipt-vision] OpenAI ${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReceiptData;
    const digits = (v: unknown) => (v ? String(v).replace(/\D/g, "") || null : null);
    return {
      amountText: parsed.amountText ?? null,
      time: parsed.time ?? null,
      operationNumber: digits(parsed.operationNumber),
      securityCode: digits(parsed.securityCode),
    };
  } catch (err) {
    console.warn("[receipt-vision] falló:", err instanceof Error ? err.message : err);
    return null;
  }
}
