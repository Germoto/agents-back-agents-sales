/**
 * Copiloto IA del editor de flujos.
 *
 * Un solo chat con la OpenAI key del TENANT: el modelo decide si responde en
 * texto (guía/preguntas) o llama a la tool `proponer_flujo` para reemplazar el
 * flujo completo del lienzo. La propuesta se valida server-side (zod +
 * validateFlow) y los errores se reinyectan al modelo hasta 3 intentos; el
 * endpoint NUNCA persiste — el frontend aplica la propuesta al canvas y el
 * usuario decide guardar.
 */

import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { resolveAiSettings } from "../../lib/ai-providers";
import { chatCompletion, type ChatMessage, type ToolDefinition } from "../../lib/openai";
import { flowNodeSchema, flowEdgeSchema, flowTriggerSchema } from "./flows.schemas";
import { validateFlow } from "./flow-validation";
import { knownFlowIds } from "./flows.service";
import { NODE_DOCS, HARD_RULES, buildBusinessContext, checkFlowReferences } from "./flow-authoring";
import { DEFAULT_TRIGGER, type FlowEdge, type FlowNode, type FlowTrigger } from "./flow-types";

const MAX_ATTEMPTS = 3;
const HISTORY_LIMIT = 16;

interface CopilotBody {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  flow: { trigger: unknown; nodes: unknown[]; edges: unknown[] };
}

// ---------------------------------------------------------------------------
// Tool: el flujo COMPLETO propuesto. `data` viaja laxo a propósito — el schema
// estricto de OpenAI no modela bien la unión discriminada de 19 tipos; la
// validación real es zod + validateFlow al recibir la llamada.
// ---------------------------------------------------------------------------
const PROPOSE_FLOW_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "proponer_flujo",
    description:
      "Reemplaza el flujo COMPLETO del lienzo del usuario. Llámala SOLO cuando el usuario pida crear o modificar su flujo. " +
      "Debes devolver TODOS los nodos y edges del flujo resultante (no solo los nuevos): lo que no incluyas desaparece.",
    parameters: {
      type: "object",
      properties: {
        resumen: {
          type: "string",
          description: "Explicación breve y cálida en español de qué hace el flujo propuesto y qué cambiaste",
        },
        trigger: {
          type: "object",
          description: "Disparador del flujo",
          properties: {
            onAnyMessage: { type: "boolean" },
            keywords: { type: "array", items: { type: "string" } },
            onFirstMessageOfDay: { type: "boolean" },
            onFirstMessageEver: { type: "boolean" },
            reactivationMinutes: { type: "number" },
          },
        },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: {
                type: "string",
                enum: [
                  "start", "send-text", "send-image", "send-video", "send-audio", "send-document",
                  "answers", "list", "flow-control", "handoff", "reminder", "crm-move",
                  "crm-add-tags", "crm-remove-tags", "condition", "wait", "question",
                  "validate-payment", "book-appointment",
                ],
              },
              position: {
                type: "object",
                properties: { x: { type: "number" }, y: { type: "number" } },
                required: ["x", "y"],
              },
              data: { type: "object", description: "Campos según el tipo de nodo (ver documentación del sistema)" },
            },
            required: ["id", "type", "position", "data"],
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              source: { type: "string" },
              sourceHandle: { type: "string" },
              target: { type: "string" },
            },
            required: ["id", "source", "sourceHandle", "target"],
          },
        },
      },
      required: ["resumen", "trigger", "nodes", "edges"],
    },
  },
};

// NODE_DOCS, HARD_RULES y buildBusinessContext viven en flow-authoring.ts
// (compartidos con crear_flujo / editar_flujo del copiloto del panel y el MCP).

function buildSystemPrompt(businessContext: string, flowState: CopilotBody["flow"], flowName: string): string {
  const isEmpty =
    flowState.nodes.length <= 1 &&
    (flowState.nodes as Array<{ type?: string }>).every((n) => n?.type === "start");
  return [
    `Eres el Copiloto de flujos de FlowApp: ayudas a dueños de negocio SIN conocimientos técnicos a armar flujos de chatbot de WhatsApp. Respondes SIEMPRE en español, breve y claro, sin jerga.`,
    `Tienes dos formas de actuar según lo que pida el usuario:`,
    `- Si pregunta, duda o pide consejo → responde en texto (puedes sugerir cómo armarlo y ofrecerte a hacerlo).`,
    `- Si pide crear, armar, cambiar, agregar o quitar algo del flujo → llama a la tool proponer_flujo con el flujo COMPLETO resultante.`,
    "",
    NODE_DOCS,
    "",
    HARD_RULES,
    "",
    `DATOS REALES DEL NEGOCIO:\n${businessContext}`,
    "",
    `FLUJO ACTUAL ("${flowName}"): ` +
      (isEmpty
        ? "el lienzo está VACÍO (solo el nodo start)."
        : JSON.stringify({ trigger: flowState.trigger, nodes: flowState.nodes, edges: flowState.edges })),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validación de la propuesta → errores legibles para reinyectar
// ---------------------------------------------------------------------------
interface ParsedProposal {
  trigger: FlowTrigger;
  nodes: FlowNode[];
  edges: FlowEdge[];
  resumen: string;
}

async function validateProposal(companyId: string, raw: unknown): Promise<{ proposal?: ParsedProposal; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;

  const trigResult = flowTriggerSchema.safeParse(obj.trigger ?? {});
  const trigger = trigResult.success ? trigResult.data : DEFAULT_TRIGGER;
  if (!trigResult.success) errors.push("trigger inválido: " + trigResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));

  const rawNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const rawEdges = Array.isArray(obj.edges) ? obj.edges : [];
  if (!rawNodes.length) errors.push("nodes está vacío");
  if (rawNodes.length > 200) errors.push("máximo 200 nodos");
  if (rawEdges.length > 500) errors.push("máximo 500 edges");

  const nodes: FlowNode[] = [];
  rawNodes.forEach((n, idx) => {
    const r = flowNodeSchema.safeParse(n);
    if (r.success) {
      nodes.push(r.data as FlowNode);
    } else {
      const id = (n as { id?: string })?.id ?? `#${idx}`;
      const type = (n as { type?: string })?.type ?? "?";
      errors.push(
        `nodo ${id} (${type}): ` + r.error.issues.map((i) => `${i.path.join(".") || "raíz"} → ${i.message}`).join("; "),
      );
    }
  });

  const edges: FlowEdge[] = [];
  rawEdges.forEach((e, idx) => {
    const r = flowEdgeSchema.safeParse(e);
    if (r.success) {
      const parsed = r.data as FlowEdge;
      edges.push({ ...parsed, sourceHandle: parsed.sourceHandle || "next" });
    } else {
      errors.push(`edge #${idx}: ` + r.error.issues.map((i) => `${i.path.join(".")} → ${i.message}`).join("; "));
    }
  });

  if (errors.length) return { errors, warnings: [] };

  const result = validateFlow(nodes, edges, { knownFlowIds: await knownFlowIds(companyId) });
  if (result.errors.length) {
    return {
      errors: result.errors.map((i) => `${i.nodeId ? `nodo ${i.nodeId}: ` : ""}${i.message}`),
      warnings: [],
    };
  }
  // Ids de CRM/etiquetas/productos ajenos: solo aviso (el editor sigue
  // aplicando la propuesta al lienzo y el usuario decide).
  const refWarnings = await checkFlowReferences(companyId, nodes);
  return {
    proposal: {
      trigger,
      nodes,
      edges,
      resumen: typeof obj.resumen === "string" && obj.resumen.trim() ? obj.resumen.trim() : "Listo, apliqué los cambios al flujo.",
    },
    errors: [],
    warnings: [...result.warnings.map((i) => i.message), ...refWarnings],
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
export async function copilotFlowController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const body = req.body as CopilotBody;

  const flow = await prisma.chatFlow.findFirst({
    where: { id: String(req.params.id), companyId },
    select: { id: true, name: true },
  });
  if (!flow) throw new AppError("Flujo no encontrado", 404);

  const agentConfig = await prisma.agentConfig.findUnique({ where: { companyId } });
  if (!agentConfig?.openaiApiKey) {
    throw new AppError("Falta la API key de IA. Configúrala en Configuración del Agente para usar el Copiloto.", 422);
  }
  const { apiKey, model, baseUrl } = resolveAiSettings(agentConfig);

  const businessContext = await buildBusinessContext(companyId);
  const system = buildSystemPrompt(businessContext, body.flow, flow.name);

  const history = body.messages.slice(-HISTORY_LIMIT);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await chatCompletion({
      apiKey,
      model,
      baseUrl,
      temperature: 0.4,
      maxTokens: 4000,
      messages,
      tools: [PROPOSE_FLOW_TOOL],
      toolChoice: "auto",
    });

    if (!r.toolCalls.length) {
      // Modo chat: respuesta en texto.
      return res.json({ reply: r.content?.trim() || "¿En qué te ayudo con tu flujo? 🙂" });
    }

    const call = r.toolCalls[0];
    let args: unknown;
    let parseError: string | null = null;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      parseError =
        r.finishReason === "length"
          ? "La respuesta se cortó por tamaño. Propón un flujo MÁS COMPACTO (menos nodos, textos más cortos)."
          : "El JSON de la tool no es válido. Vuelve a llamar proponer_flujo con JSON bien formado.";
    }

    const check = parseError ? { errors: [parseError], warnings: [] as string[] } : await validateProposal(companyId, args);
    if (!parseError && check.proposal) {
      return res.json({
        reply: check.proposal.resumen,
        proposal: {
          trigger: check.proposal.trigger,
          nodes: check.proposal.nodes,
          edges: check.proposal.edges,
          summary: check.proposal.resumen,
          warnings: check.warnings,
        },
      });
    }

    // Reinyectar errores y reintentar.
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content:
        "ERRORES DE VALIDACIÓN — corrige y vuelve a llamar proponer_flujo con el flujo completo corregido:\n- " +
        check.errors.slice(0, 20).join("\n- "),
    });
  }

  return res.json({
    reply:
      "No logré armar un flujo válido con esa petición 😅. ¿Puedes describirla de otra forma o pedírmelo por partes? (ej. primero el menú de bienvenida, luego el cobro)",
  });
}
