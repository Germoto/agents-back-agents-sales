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
  securityCode: string | null;
}

const SYSTEM =
  "Eres un lector de comprobantes de pago de Yape y Plin (Perú). Devuelves SOLO JSON. " +
  "Lee la imagen y extrae: el monto pagado (amountText, ej. 'S/ 5.00'), la hora/fecha que aparezca " +
  "(time, texto tal cual), y el código de seguridad o de operación si aparece (securityCode, ej. en " +
  "'código de seguridad: 123' devuelve '123'). NO inventes ni infieras el nombre de quien paga (la " +
  "constancia muestra al destinatario, no al pagador). Si un dato no aparece, usa null.";

const SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "receipt",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["amountText", "time", "securityCode"],
      properties: {
        amountText: { type: ["string", "null"] },
        time: { type: ["string", "null"] },
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
    return {
      amountText: parsed.amountText ?? null,
      time: parsed.time ?? null,
      securityCode: parsed.securityCode ? String(parsed.securityCode).replace(/\D/g, "") || null : null,
    };
  } catch (err) {
    console.warn("[receipt-vision] falló:", err instanceof Error ? err.message : err);
    return null;
  }
}
