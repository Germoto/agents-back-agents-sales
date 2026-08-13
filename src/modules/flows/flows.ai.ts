/**
 * Sugerencias de texto con IA para campos de flujos (usa la OpenAI key del
 * tenant). Hoy soporta `kind: "reminder"` — el mensaje de un recordatorio —,
 * pensado para extenderse a otros campos de texto libre del editor de flujos.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { resolveAiSettings } from "../../lib/ai-providers";
import { chatCompletion } from "../../lib/openai";

export const flowAiSuggestSchema = z.object({
  kind: z.enum(["reminder"]),
  context: z
    .object({
      minutes: z.number().int().min(0).optional(),
      existing: z.string().max(2000).optional().nullable(),
    })
    .default({}),
});

type FlowAiBody = z.infer<typeof flowAiSuggestSchema>;

const KIND_INSTRUCTIONS: Record<FlowAiBody["kind"], string> = {
  reminder:
    "Escribe UN mensaje de recordatorio de WhatsApp, breve (1-2 frases), cálido y natural, para reenganchar a un cliente que dejó de responder e invitarlo a continuar. En español neutro, 1 emoji como máximo. No inventes datos concretos (precios, links, nombres). Devuelve SOLO el texto del mensaje, sin comillas.",
};

export async function flowAiSuggestController(req: Request, res: Response) {
  const body = req.body as FlowAiBody;
  const companyId = req.user!.companyId;

  const [agentConfig, company] = await Promise.all([
    prisma.agentConfig.findUnique({ where: { companyId }, select: { openaiApiKey: true, openaiModel: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, vertical: true } }),
  ]);
  if (!agentConfig?.openaiApiKey) {
    throw new AppError(
      "Falta la API key de IA. Configúrala en Configuración del Agente para usar sugerencias con IA.",
      422,
    );
  }

  const { apiKey, model, baseUrl } = resolveAiSettings(agentConfig);

  const contextLines: string[] = [`Negocio: ${company?.name ?? "—"} (rubro ${company?.vertical ?? "OTHER"}).`];
  if (typeof body.context.minutes === "number" && body.context.minutes > 0) {
    contextLines.push(`Se envía tras ${body.context.minutes} minutos sin respuesta del cliente.`);
  }
  if (body.context.existing?.trim()) {
    contextLines.push(`Mensaje actual (mejóralo o propón una alternativa distinta): ${body.context.existing.trim()}`);
  }

  const r = await chatCompletion({
    apiKey,
    model,
    baseUrl,
    temperature: 0.7,
    maxTokens: 300,
    messages: [
      {
        role: "system",
        content:
          "Eres un copywriter de mensajes de WhatsApp para ventas conversacionales. Respondes SIEMPRE en español, cálido y natural, sin comillas ni comentarios extra.",
      },
      { role: "user", content: `${contextLines.join("\n")}\n\nTarea:\n${KIND_INSTRUCTIONS[body.kind]}` },
    ],
  });

  const suggestion = (r.content ?? "").trim().replace(/^["“]|["”]$/g, "");
  if (!suggestion) throw new AppError("No se pudo generar una sugerencia", 502);
  return res.json({ suggestion });
}
