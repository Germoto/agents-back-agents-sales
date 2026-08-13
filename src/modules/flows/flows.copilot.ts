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

// ---------------------------------------------------------------------------
// Documentación compacta de los bloques (espejo de flow-types.ts). Mantener en
// sincronía si se agregan tipos de nodo.
// ---------------------------------------------------------------------------
const NODE_DOCS = `BLOQUES DISPONIBLES (type → data → handles de salida para edges):
- start: data {} → salida "next". SIEMPRE debe existir exactamente UN nodo start (id "start").
- send-text: {text, saveVariable?} → "next" (sigue de inmediato) y "reply" (espera respuesta del cliente). El texto soporta {{variables}}.
- send-image | send-video | send-audio | send-document: {mediaUrl, fileName?, caption?} → "next" y "reply". Solo úsalos si el usuario tiene la URL del archivo; si no, sugiere que suba el archivo y prefiere send-text.
- answers: {message, options:[{id,label,detectText,detectMode:"contains"|"equals"|"starts_with"|"ends_with"}] (máx 15), repeatOnNoMatch, noMatchMessage?, timeoutMinutes?} → un handle "opt:<id de cada opción>" y "timeout" (solo si timeoutMinutes>0). Menú de botones sugeridos; detectText = lo que escribe el cliente (ej. "1", "sí", "precio").
- list: {title?, body, footer?, sections:[{id,title,options:[{id,label,description?}]}], repeatOnNoMatch, noMatchMessage?, timeoutMinutes?} → "opt:<id de cada opción>" y "timeout". Menú numerado largo (el cliente responde con el número).
- question: {message, varType:"text"|"number"|"email"|"phone", saveVariable, invalidMessage?, timeoutMinutes?} → "next" (y "timeout" si timeoutMinutes>0). Pide un dato, lo valida y lo guarda en {{saveVariable}} (snake_case).
- condition: {source:"variable"|"tag"|"purchased", variable?, operator?:"equals"|"contains"|"not_empty"|"empty", value?, tagId?} → "yes" y "no". source=variable exige variable+operator; source=tag exige tagId.
- wait: {seconds} (1-120) → "next". Pausa corta entre mensajes.
- reminder: {steps:[{id,minutes,message}]} (máx 5, delays ACUMULATIVOS desde que el cliente deja de responder) → "next". Se cancela solo si el cliente responde.
- validate-payment: {amountMode:"fixed"|"product", amount? (si fixed), productId? (si product), instructions?, retryMessage?, reviewMessage?, timeoutMinutes? (default 60)} → "approved", "rejected", "review" y "timeout". Cobra (Yape/Plin/Mercado Pago según lo configurado) y valida el comprobante automáticamente.
- book-appointment: {productId? (servicio con agenda), introMessage?, noSlotsMessage?, saveVariable?, timeoutMinutes? (default 30)} → "booked", "no-slots" y "timeout". Ofrece horarios REALES de la agenda y agenda la cita; deja {{cita_fecha}} y {{cita_codigo}}.
- crm-move: {crmId, crmColumnId, crmColumnName?} → "next". Mueve al cliente a una columna del CRM.
- crm-add-tags | crm-remove-tags: {tagIds:[uuid]} → "next". Asigna/quita etiquetas.
- handoff: {clientText?, notifyText?} → SIN salidas (terminal). Pausa el bot y avisa a un asesor humano.
- flow-control: {action:"restart"|"transfer", targetFlowId? (si transfer)} → SIN salidas (terminal). Reinicia este flujo o transfiere a otro.

VARIABLES: en cualquier texto puedes usar {{nombre}}, {{telefono}} y las guardadas con saveVariable (ej. {{correo}}).`;

const HARD_RULES = `REGLAS OBLIGATORIAS al proponer un flujo:
1. Exactamente UN nodo start (id "start", data {}); su edge sale por "next" hacia el primer bloque.
2. IDs únicos con formato <tipo>-<sufijo de 6 caracteres> (ej. "send-text-k3f9a2", "answers-x81mq0"). Conserva los IDs de los nodos existentes que no cambies. IDs de opciones: "opt-<6 chars>".
3. Cada edge: {id:"e-<6 chars>", source:<id nodo>, sourceHandle:<handle VÁLIDO del nodo origen según su tipo y data>, target:<id nodo>}. Un handle solo puede tener UN edge.
4. Todo nodo debe ser alcanzable desde start. No dejes ramas de answers/list sin conectar (cada opción con su edge "opt:<id>").
5. Textos al cliente: español cálido y claro, emojis con moderación. Nada de datos inventados (precios, links).
6. LAYOUT: start en x=80. Cada paso avanza x en +300. Ramas paralelas se separan en y de a 160 (y base 240). Sin superposiciones.
7. Si el usuario pide modificar, parte del ESTADO ACTUAL del lienzo y conserva todo lo que no pidió cambiar (incluidas posiciones).
8. Usa SOLO los IDs reales del negocio listados abajo para productId, crmId, crmColumnId y tagIds. Si el dato que necesitas no existe (ej. no hay productos o no hay pagos configurados), NO inventes IDs: explícalo en el resumen y usa una alternativa (ej. handoff).
9. En el trigger: si el usuario no especifica cómo se dispara, usa keywords razonables según el tema del flujo y menciónalo en el resumen.`;

// ---------------------------------------------------------------------------
// Contexto del negocio (selects mínimos)
// ---------------------------------------------------------------------------
async function buildBusinessContext(companyId: string): Promise<string> {
  const [company, products, crms, tags, paymentMethods, flows] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, vertical: true } }),
    prisma.product.findMany({
      where: { companyId, active: true },
      select: { id: true, name: true, price: true, productType: true, durationMin: true },
      take: 30,
      orderBy: { createdAt: "desc" },
    }),
    prisma.crm.findMany({
      where: { companyId },
      select: { id: true, name: true, columns: { select: { id: true, name: true }, orderBy: { sortOrder: "asc" } } },
      take: 5,
    }),
    prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true }, take: 30 }),
    prisma.paymentMethod.count({ where: { paymentConfig: { companyId } } }),
    prisma.chatFlow.findMany({ where: { companyId }, select: { id: true, name: true }, take: 20 }),
  ]);

  const lines: string[] = [`Negocio: ${company?.name ?? "—"} (rubro ${company?.vertical ?? "OTHER"}).`];
  if (products.length) {
    lines.push(
      "Productos (para productId): " +
        products
          .map((p) => `${p.name} (id=${p.id}, ${p.price ?? "sin precio"}, ${p.productType}${p.durationMin ? `, agenda ${p.durationMin}min` : ""})`)
          .join("; "),
    );
  } else {
    lines.push("No hay productos configurados (no uses validate-payment con amountMode=product ni book-appointment con productId).");
  }
  if (crms.length) {
    lines.push(
      "CRMs (para crm-move): " +
        crms.map((c) => `${c.name} (crmId=${c.id}) columnas: ${c.columns.map((col) => `${col.name}=${col.id}`).join(", ")}`).join(" | "),
    );
  } else {
    lines.push("No hay CRM configurado (no propongas bloques crm-move).");
  }
  if (tags.length) {
    lines.push("Etiquetas (para tagIds): " + tags.map((t) => `${t.name}=${t.id}`).join(", "));
  } else {
    lines.push("No hay etiquetas creadas (no propongas bloques de etiquetas).");
  }
  lines.push(
    paymentMethods > 0
      ? "El negocio SÍ tiene métodos de pago configurados (puedes usar validate-payment)."
      : "El negocio NO tiene métodos de pago configurados: NO propongas validate-payment (sugiere configurarlos en Pagos).",
  );
  if (flows.length > 1) {
    lines.push("Otros flujos (para flow-control transfer): " + flows.map((f) => `${f.name}=${f.id}`).join(", "));
  }
  return lines.join("\n");
}

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

function validateProposal(raw: unknown): { proposal?: ParsedProposal; errors: string[]; warnings: string[] } {
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

  const result = validateFlow(nodes, edges);
  if (result.errors.length) {
    return {
      errors: result.errors.map((i) => `${i.nodeId ? `nodo ${i.nodeId}: ` : ""}${i.message}`),
      warnings: [],
    };
  }
  return {
    proposal: {
      trigger,
      nodes,
      edges,
      resumen: typeof obj.resumen === "string" && obj.resumen.trim() ? obj.resumen.trim() : "Listo, apliqué los cambios al flujo.",
    },
    errors: [],
    warnings: result.warnings.map((i) => i.message),
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

    const check = parseError ? { errors: [parseError], warnings: [] as string[] } : validateProposal(args);
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
