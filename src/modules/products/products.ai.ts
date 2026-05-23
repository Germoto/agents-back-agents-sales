import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

export const aiSuggestBodySchema = z.object({
  field: z.enum([
    "shortDescription",
    "fullDescription",
    "benefits",
    "includes",
    "bonuses",
    "faqs",
    "objections",
    "aliases",
  ]),
  context: z.object({
    name: z.string().trim().min(1, "El nombre del producto es obligatorio para sugerir"),
    productType: z.enum(["DIGITAL", "PHYSICAL"]).default("DIGITAL"),
    price: z.string().optional().nullable(),
    regularPrice: z.string().optional().nullable(),
    shortDescription: z.string().optional().nullable(),
    fullDescription: z.string().optional().nullable(),
    existing: z.array(z.string()).optional().default([]),
    existingQa: z
      .array(z.object({ question: z.string(), answer: z.string().optional().nullable() }))
      .optional()
      .default([]),
  }),
});

type AiSuggestBody = z.infer<typeof aiSuggestBodySchema>;

const FIELD_INSTRUCTIONS: Record<AiSuggestBody["field"], string> = {
  shortDescription:
    "Genera UNA sola frase de catálogo, máximo 140 caracteres, en español neutro, clara y atractiva. No uses emojis. Devuelve solo el texto, sin comillas.",
  fullDescription:
    "Genera una descripción completa del producto en español neutro, en 2-4 párrafos cortos separados por saltos de línea. Habla del valor, a quién va dirigido y qué obtiene. No uses listas, no uses emojis.",
  benefits:
    "Genera 5 beneficios concretos del producto, en español neutro, frases cortas (máx. 90 caracteres cada una), enfocadas en el resultado para el cliente.",
  includes:
    "Genera 5 elementos concretos que incluye el producto al comprarlo, en español neutro, frases cortas (máx. 90 caracteres), específicas y verificables.",
  bonuses:
    "Genera 4 bonos o extras atractivos que complementen el producto, en español neutro, frases cortas (máx. 90 caracteres).",
  faqs:
    "Genera 5 preguntas frecuentes con sus respuestas. Cada elemento debe tener 'question' (pregunta natural que haría un cliente real por WhatsApp) y 'answer' (respuesta clara, 1-3 frases). En español neutro.",
  objections:
    "Genera 5 objeciones típicas (dudas o frenos antes de comprar) con su respuesta persuasiva. Cada elemento debe tener 'question' (la objeción en primera persona, ej. 'No tengo tiempo') y 'answer' (respuesta empática que avanza la venta). En español neutro.",
  aliases:
    "Genera 6 alias o variaciones de búsqueda para este producto: sinónimos, errores comunes de tipeo, formas coloquiales. NO se muestran al cliente, sirven para que un bot reconozca al producto. Palabras o frases cortas en minúsculas.",
};

const LIST_FIELDS = new Set<AiSuggestBody["field"]>(["benefits", "includes", "bonuses", "aliases"]);
const QA_FIELDS = new Set<AiSuggestBody["field"]>(["faqs", "objections"]);
const TEXT_FIELDS = new Set<AiSuggestBody["field"]>(["shortDescription", "fullDescription"]);

function buildSchemaForField(field: AiSuggestBody["field"]) {
  if (TEXT_FIELDS.has(field)) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["suggestion"],
      properties: { suggestion: { type: "string" } },
    };
  }
  if (LIST_FIELDS.has(field)) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["suggestions"],
      properties: {
        suggestions: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
        },
      },
    };
  }
  // QA
  return {
    type: "object",
    additionalProperties: false,
    required: ["suggestions"],
    properties: {
      suggestions: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "answer"],
          properties: {
            question: { type: "string" },
            answer: { type: "string" },
          },
        },
      },
    },
  };
}

function buildUserPrompt(body: AiSuggestBody) {
  const { field, context } = body;
  const lines: string[] = [];
  lines.push(`Producto: ${context.name}`);
  lines.push(`Tipo: ${context.productType === "DIGITAL" ? "Digital (curso, descarga, acceso online)" : "Físico (con envío)"}`);
  if (context.price?.trim()) lines.push(`Precio: ${context.price}`);
  if (context.regularPrice?.trim()) lines.push(`Precio regular (antes): ${context.regularPrice}`);
  if (context.shortDescription?.trim()) lines.push(`Descripción corta actual: ${context.shortDescription}`);
  if (context.fullDescription?.trim()) lines.push(`Descripción completa actual: ${context.fullDescription}`);

  if (LIST_FIELDS.has(field) && context.existing && context.existing.length > 0) {
    lines.push(`\nYa existen estos elementos (NO los repitas, sugiere COMPLEMENTARIOS o distintos):`);
    context.existing.forEach((item) => lines.push(`- ${item}`));
  }

  if (QA_FIELDS.has(field) && context.existingQa && context.existingQa.length > 0) {
    lines.push(`\nYa existen estas preguntas/objeciones (NO las repitas):`);
    context.existingQa.forEach((qa) => lines.push(`- ${qa.question}`));
  }

  lines.push("");
  lines.push("Tarea:");
  lines.push(FIELD_INSTRUCTIONS[field]);

  return lines.join("\n");
}

type OpenAIResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

async function callOpenAI(opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schema: object;
  schemaName: string;
}): Promise<unknown> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.7,
      max_tokens: 800,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: opts.schemaName,
          strict: true,
          schema: opts.schema,
        },
      },
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const data = (await response.json()) as OpenAIResponse;
      detail = data?.error?.message ?? "";
    } catch {
      // ignore
    }
    throw new AppError(
      `Error al consultar OpenAI (${response.status})${detail ? `: ${detail}` : ""}`,
      response.status === 401 ? 401 : 502,
    );
  }

  const data = (await response.json()) as OpenAIResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new AppError("Respuesta vacía de OpenAI", 502);
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new AppError("Respuesta de OpenAI no es JSON válido", 502);
  }
}

export async function aiSuggestProductFieldController(req: Request, res: Response) {
  const body = req.body as AiSuggestBody;
  const companyId = req.user!.companyId;

  const agentConfig = await prisma.agentConfig.findUnique({ where: { companyId } });
  if (!agentConfig?.openaiApiKey) {
    throw new AppError(
      "Falta la API key de OpenAI. Configúrala en Configuración del Agente para usar sugerencias con IA.",
      422,
    );
  }

  const model = agentConfig.openaiModel || "gpt-4o-mini";
  const systemPrompt =
    "Eres un copywriter experto en e-commerce y ventas conversacionales por WhatsApp. " +
    "Generas contenido para fichas de producto que serán usadas por un bot vendedor. " +
    "Respondes SIEMPRE en español neutro, sin emojis, sin disclaimers, sin saludos. " +
    "Sé concreto, profesional y orientado a beneficios. Devuelve únicamente el JSON solicitado.";

  const userPrompt = buildUserPrompt(body);
  const schema = buildSchemaForField(body.field);

  const parsed = (await callOpenAI({
    apiKey: agentConfig.openaiApiKey,
    model,
    systemPrompt,
    userPrompt,
    schema,
    schemaName: `product_${body.field}_suggestion`,
  })) as Record<string, unknown>;

  if (TEXT_FIELDS.has(body.field)) {
    const suggestion = typeof parsed.suggestion === "string" ? parsed.suggestion.trim() : "";
    return res.json({ field: body.field, suggestion });
  }

  if (LIST_FIELDS.has(body.field)) {
    const list = Array.isArray(parsed.suggestions)
      ? (parsed.suggestions as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : [];
    return res.json({ field: body.field, suggestions: list });
  }

  // QA
  const list = Array.isArray(parsed.suggestions)
    ? (parsed.suggestions as unknown[]).filter(
        (x): x is { question: string; answer: string } =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as { question?: unknown }).question === "string" &&
          typeof (x as { answer?: unknown }).answer === "string",
      )
    : [];
  return res.json({ field: body.field, suggestions: list });
}
