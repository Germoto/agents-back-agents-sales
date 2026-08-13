/**
 * Lectura del comprobante de pago (Yape/Plin) con visión. Hace UNA llamada
 * aislada a OpenAI (multimodal) y devuelve datos estructurados. La constancia
 * NO muestra el nombre de quien paga (muestra el destino = nuestro titular);
 * lo confiable es el MONTO, la HORA y, en Yape→Yape, un CÓDIGO DE SEGURIDAD
 * (suele aparecer como "código: 123"). No se infiere el nombre del pagador.
 */

import { parseJsonLoose, prepareImageUrl } from "../../lib/ai-providers";

export interface ReceiptData {
  amountText: string | null;
  time: string | null;
  /** N° de operación: está en TODOS los comprobantes (Yape/Plin). Llave principal. */
  operationNumber: string | null;
  /** Código de seguridad (solo Yape→Yape, 3 dígitos). Llave secundaria. */
  securityCode: string | null;
  /** ¿La imagen ES un comprobante/captura de pago? (juicio del modelo, aunque no se
   *  hayan podido leer todos los datos). Permite distinguir un comprobante borroso de
   *  una foto cualquiera que el cliente manda como parte de la conversación. */
  isReceipt: boolean;
  /** Descripción corta y neutral de QUÉ muestra la imagen (sea o no comprobante).
   *  Le da "ojos" al agente (que es texto-only) para responder en contexto. */
  description: string | null;
}

const SYSTEM =
  "Eres un analista de imágenes para un chat de ventas por WhatsApp (Perú). Devuelves SOLO JSON. " +
  "PRIMERO clasifica: isReceipt = true SOLO si la imagen es un comprobante/captura de un pago " +
  "(Yape, Plin, transferencia bancaria: muestra monto pagado, 'Nro de operación', 'pago exitoso', etc.). " +
  "Si es cualquier otra cosa (una foto de un producto, un álbum, una pantalla, un meme, un documento que " +
  "no es de pago), isReceipt = false. " +
  "Si isReceipt, extrae: el monto pagado (amountText, ej. 'S/ 5.00'); la hora/fecha que aparezca " +
  "(time, texto tal cual); el CÓDIGO DE SEGURIDAD (securityCode), que aparece SOLO en transferencias " +
  "Yape→Yape, rotulado 'CÓDIGO DE SEGURIDAD' o 'cód'. Suele ser de 3 dígitos y puede mostrarse en casillas " +
  "separadas (ej. '0 7 3' → devuelve '073'; conserva el cero inicial). Si NO aparece un código de seguridad, " +
  "securityCode = null. Además, el NÚMERO DE OPERACIÓN (operationNumber, el numerito largo rotulado 'Nro de operación'). " +
  "NO inventes ni infieras el nombre de quien paga: la constancia muestra al DESTINATARIO (a quién se le pagó), " +
  "no al pagador. Si un dato no aparece, usa null. Si NO es comprobante, deja amountText/time/operationNumber/securityCode en null. " +
  "SIEMPRE devuelve 'description': una frase corta y neutral en español de qué muestra la imagen " +
  "(ej. 'foto de un álbum de stickers Copa Mundial', 'captura de un pago Yape por S/5', 'foto de un producto').";

const SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "receipt",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["isReceipt", "amountText", "time", "operationNumber", "securityCode", "description"],
      properties: {
        isReceipt: { type: "boolean" },
        amountText: { type: ["string", "null"] },
        time: { type: ["string", "null"] },
        operationNumber: { type: ["string", "null"] },
        securityCode: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
      },
    },
  },
};

/** Lee un comprobante con el proveedor de IA del tenant. Devuelve null si falla
 *  (best-effort, no rompe el turno). Fuera de OpenAI: imagen como data-URI y
 *  JSON por prompt (sin response_format). */
export async function readReceiptImage(
  ai: { apiKey: string; model: string; baseUrl?: string; caps?: { jsonSchema: boolean; inlineImages: boolean } },
  imageUrl: string,
): Promise<ReceiptData | null> {
  try {
    const useJsonSchema = ai.caps?.jsonSchema !== false;
    const finalUrl = ai.caps?.inlineImages ? await prepareImageUrl(imageUrl, ai.caps) : imageUrl;
    const base = (ai.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0,
        max_tokens: 300,
        ...(useJsonSchema ? { response_format: SCHEMA } : {}),
        messages: [
          {
            role: "system",
            content: useJsonSchema
              ? SYSTEM
              : `${SYSTEM} Devuelve ÚNICAMENTE un objeto JSON con las claves isReceipt, amountText, time, operationNumber, securityCode y description — sin explicación ni markdown.`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Lee este comprobante y devuelve el JSON pedido." },
              { type: "image_url", image_url: { url: finalUrl } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      console.warn(`[receipt-vision] proveedor IA ${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = parseJsonLoose(raw) as ReceiptData | null;
    if (!parsed) return null;
    const digits = (v: unknown) => (v ? String(v).replace(/\D/g, "") || null : null);
    return {
      isReceipt: parsed.isReceipt === true,
      amountText: parsed.amountText ?? null,
      time: parsed.time ?? null,
      operationNumber: digits(parsed.operationNumber),
      securityCode: digits(parsed.securityCode),
      description: parsed.description?.trim() ? parsed.description.trim() : null,
    };
  } catch (err) {
    console.warn("[receipt-vision] falló:", err instanceof Error ? err.message : err);
    return null;
  }
}
