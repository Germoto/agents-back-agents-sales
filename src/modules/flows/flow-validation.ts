/**
 * Validación lógica del grafo de un flujo. Fuente de verdad (el frontend
 * mantiene un espejo para feedback en vivo; el backend revalida al activar).
 */

import {
  type FlowNode,
  type FlowEdge,
  type AnswersData,
  type ListData,
  type FlowControlData,
  type ReminderData,
  type CrmMoveData,
  type CrmTagsData,
  type ConditionData,
  type WaitData,
  type QuestionData,
  type SendTextData,
  type SendMediaData,
  outputHandlesFor,
  flattenListOptions,
  isSendNode,
  TERMINAL_NODE_TYPES,
} from "./flow-types";

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateFlowOptions {
  /** Ids de flujos válidos de la empresa (para validar transfer). Si se omite, no se valida el destino. */
  knownFlowIds?: string[];
}

const NODE_LABEL: Record<string, string> = {
  "start": "Inicio",
  "send-text": "Enviar Texto",
  "send-image": "Enviar Imagen",
  "send-video": "Enviar Vídeo",
  "send-audio": "Enviar Audio",
  "send-document": "Enviar Documento",
  "answers": "Respuestas",
  "list": "Enviar Lista",
  "flow-control": "Control de Flujo",
  "handoff": "Derivar a humano",
  "reminder": "Recordatorio",
  "crm-move": "Mover en CRM",
  "crm-add-tags": "Asignar etiquetas",
  "crm-remove-tags": "Quitar etiquetas",
  "condition": "Condición",
  "wait": "Esperar",
  "question": "Pregunta",
};

function label(node: FlowNode): string {
  return NODE_LABEL[node.type] ?? node.type;
}

export function validateFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  opts: ValidateFlowOptions = {},
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // --- Inicio ---
  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) {
    errors.push({
      code: "START_REQUIRED",
      message: starts.length === 0 ? "El flujo no tiene bloque de Inicio." : "El flujo tiene más de un Inicio.",
    });
  }
  const start = starts[0];
  if (start) {
    const startEdges = edges.filter((e) => e.source === start.id);
    if (startEdges.length !== 1) {
      errors.push({
        code: "START_OUTPUT",
        message:
          startEdges.length === 0
            ? "El Inicio debe conectarse a un bloque."
            : "El Inicio solo puede conectarse a un bloque.",
        nodeId: start.id,
      });
    }
  }

  // --- Aristas ---
  const handleSeen = new Map<string, FlowEdge>();
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      errors.push({ code: "DANGLING_EDGE", message: "Hay una conexión a un bloque inexistente.", edgeId: edge.id });
      continue;
    }
    if (edge.source === edge.target) {
      errors.push({
        code: "SELF_LOOP",
        message: `«${label(source)}» no puede conectarse a sí mismo.`,
        edgeId: edge.id,
        nodeId: source.id,
      });
    }
    // Handle válido para el tipo de nodo
    const valid = outputHandlesFor(source);
    const handle = edge.sourceHandle ?? "next";
    if (source.type !== "start" && !valid.includes(handle)) {
      if (TERMINAL_NODE_TYPES.includes(source.type)) {
        errors.push({
          code: "TERMINAL_WITH_OUTPUT",
          message: `«${label(source)}» es un bloque final y no puede tener salidas.`,
          edgeId: edge.id,
          nodeId: source.id,
        });
      } else {
        errors.push({
          code: "INVALID_HANDLE",
          message: `Conexión inválida desde «${label(source)}» (salida «${handle}» inexistente).`,
          edgeId: edge.id,
          nodeId: source.id,
        });
      }
    }
    // Una sola arista por salida
    const key = `${edge.source}::${handle}`;
    if (handleSeen.has(key)) {
      errors.push({
        code: "DUPLICATE_HANDLE_EDGE",
        message: `«${label(source)}» tiene más de una conexión en la misma salida.`,
        edgeId: edge.id,
        nodeId: source.id,
      });
    } else {
      handleSeen.set(key, edge);
    }
  }

  const edgeFrom = (nodeId: string, handle: string) =>
    edges.find((e) => e.source === nodeId && (e.sourceHandle ?? "next") === handle);

  // --- Contenido por nodo ---
  for (const node of nodes) {
    switch (node.type) {
      case "send-text": {
        const data = node.data as SendTextData;
        if (!data.text?.trim()) {
          errors.push({ code: "TEXT_REQUIRED", message: "«Enviar Texto» sin mensaje.", nodeId: node.id });
        }
        break;
      }
      case "send-image":
      case "send-video":
      case "send-audio":
      case "send-document": {
        const data = node.data as SendMediaData;
        if (!data.mediaUrl?.trim()) {
          errors.push({
            code: "MEDIA_REQUIRED",
            message: `«${label(node)}» sin archivo adjunto.`,
            nodeId: node.id,
          });
        }
        break;
      }
      case "answers": {
        const data = node.data as AnswersData;
        const options = data.options ?? [];
        if (!data.message?.trim()) {
          errors.push({ code: "TEXT_REQUIRED", message: "«Respuestas» sin mensaje/pregunta.", nodeId: node.id });
        }
        if (!options.length) {
          errors.push({ code: "ANSWERS_NO_OPTIONS", message: "«Respuestas» sin opciones.", nodeId: node.id });
        }
        const seen = new Set<string>();
        for (const opt of options) {
          if (!opt.detectText?.trim()) {
            errors.push({
              code: "ANSWERS_NO_OPTIONS",
              message: "«Respuestas» tiene una opción sin texto a detectar.",
              nodeId: node.id,
            });
            break;
          }
          const k = opt.detectText.trim().toLowerCase();
          if (seen.has(k)) {
            errors.push({
              code: "DUPLICATE_OPTION",
              message: `«Respuestas» tiene opciones duplicadas («${opt.detectText}»).`,
              nodeId: node.id,
            });
          }
          seen.add(k);
        }
        validateTimeout(node, data.timeoutMinutes, edgeFrom, errors, warnings);
        break;
      }
      case "list": {
        const data = node.data as ListData;
        const flat = flattenListOptions(data);
        if (!data.body?.trim()) {
          errors.push({ code: "TEXT_REQUIRED", message: "«Enviar Lista» sin descripción.", nodeId: node.id });
        }
        if (!flat.length) {
          errors.push({ code: "LIST_NO_OPTIONS", message: "«Enviar Lista» sin opciones.", nodeId: node.id });
        }
        const seen = new Set<string>();
        for (const opt of flat) {
          if (!opt.label?.trim()) {
            errors.push({
              code: "LIST_NO_OPTIONS",
              message: "«Enviar Lista» tiene una opción sin nombre.",
              nodeId: node.id,
            });
            break;
          }
          const k = opt.label.trim().toLowerCase();
          if (seen.has(k)) {
            errors.push({
              code: "DUPLICATE_OPTION",
              message: `«Enviar Lista» tiene opciones duplicadas («${opt.label}»).`,
              nodeId: node.id,
            });
          }
          seen.add(k);
        }
        validateTimeout(node, data.timeoutMinutes, edgeFrom, errors, warnings);
        break;
      }
      case "flow-control": {
        const data = node.data as FlowControlData;
        if (data.action !== "restart" && data.action !== "transfer") {
          errors.push({
            code: "FLOWCTRL_NO_ACTION",
            message: "«Control de Flujo» sin acción seleccionada (Reiniciar o Transferir).",
            nodeId: node.id,
          });
        } else if (data.action === "transfer") {
          if (!data.targetFlowId) {
            errors.push({
              code: "FLOWCTRL_BAD_TARGET",
              message: "«Control de Flujo» (Transferir) sin flujo de destino.",
              nodeId: node.id,
            });
          } else if (opts.knownFlowIds && !opts.knownFlowIds.includes(data.targetFlowId)) {
            errors.push({
              code: "FLOWCTRL_BAD_TARGET",
              message: "«Control de Flujo» apunta a un flujo que ya no existe.",
              nodeId: node.id,
            });
          }
        }
        break;
      }
      case "reminder": {
        const data = node.data as ReminderData;
        if (!Number.isFinite(data.minutes) || data.minutes <= 0 || !data.message?.trim()) {
          errors.push({
            code: "REMINDER_INVALID",
            message: "«Recordatorio» necesita minutos > 0 y un mensaje.",
            nodeId: node.id,
          });
        }
        break;
      }
      case "crm-move": {
        const data = node.data as CrmMoveData;
        if (!data.crmId || !data.crmColumnId) {
          errors.push({
            code: "CRM_MOVE_INCOMPLETE",
            message: "«Mover en CRM» sin tablero o columna seleccionada.",
            nodeId: node.id,
          });
        }
        break;
      }
      case "crm-add-tags":
      case "crm-remove-tags": {
        const data = node.data as CrmTagsData;
        if (!data.tagIds?.length) {
          errors.push({
            code: "CRM_TAGS_EMPTY",
            message: `«${label(node)}» sin etiquetas seleccionadas.`,
            nodeId: node.id,
          });
        }
        break;
      }
      case "condition": {
        const data = node.data as ConditionData;
        const incomplete =
          (data.source === "variable" && (!data.variable?.trim() || !data.operator)) ||
          (data.source === "tag" && !data.tagId) ||
          (data.source === "variable" &&
            (data.operator === "equals" || data.operator === "contains") &&
            !data.value?.trim());
        if (incomplete) {
          errors.push({
            code: "CONDITION_INCOMPLETE",
            message: "«Condición» sin configurar por completo.",
            nodeId: node.id,
          });
        }
        if (!edgeFrom(node.id, "yes") && !edgeFrom(node.id, "no")) {
          errors.push({
            code: "CONDITION_NO_OUTPUTS",
            message: "«Condición» no tiene ninguna salida conectada.",
            nodeId: node.id,
          });
        } else if (!edgeFrom(node.id, "yes") || !edgeFrom(node.id, "no")) {
          warnings.push({
            code: "CONDITION_ONE_OUTPUT",
            message: "«Condición» tiene solo una rama conectada; la otra terminará el flujo.",
            nodeId: node.id,
          });
        }
        break;
      }
      case "wait": {
        const data = node.data as WaitData;
        if (!Number.isFinite(data.seconds) || data.seconds < 1 || data.seconds > 120) {
          errors.push({
            code: "WAIT_INVALID",
            message: "«Esperar» necesita entre 1 y 120 segundos.",
            nodeId: node.id,
          });
        }
        break;
      }
      case "question": {
        const data = node.data as QuestionData;
        if (!data.message?.trim()) {
          errors.push({ code: "QUESTION_INCOMPLETE", message: "«Pregunta» sin mensaje.", nodeId: node.id });
        }
        if (!data.saveVariable?.trim()) {
          errors.push({
            code: "QUESTION_INCOMPLETE",
            message: "«Pregunta» sin variable donde guardar la respuesta.",
            nodeId: node.id,
          });
        }
        validateTimeout(node, data.timeoutMinutes, edgeFrom, errors, warnings);
        break;
      }
    }

    // next y reply son excluyentes en bloques de envío
    if (isSendNode(node.type)) {
      if (edgeFrom(node.id, "next") && edgeFrom(node.id, "reply")) {
        errors.push({
          code: "SEND_BOTH_OUTPUTS",
          message: `«${label(node)}» no puede usar «Llamar al siguiente bloque» y «Cuando responda» a la vez.`,
          nodeId: node.id,
        });
      }
    }
  }

  // --- Ciclos (DFS sobre todas las aristas; loops legítimos solo via Reiniciar / repetir pregunta) ---
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
  }
  const color = new Map<string, 0 | 1 | 2>(); // 0=blanco 1=gris 2=negro
  let cycleAt: string | null = null;
  const dfs = (id: string): void => {
    if (cycleAt) return;
    color.set(id, 1);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        cycleAt = next;
        return;
      }
      if (c === 0) dfs(next);
    }
    color.set(id, 2);
  };
  for (const node of nodes) {
    if ((color.get(node.id) ?? 0) === 0) dfs(node.id);
  }
  if (cycleAt) {
    const node = nodeById.get(cycleAt);
    errors.push({
      code: "CYCLE",
      message: `El flujo tiene un ciclo de conexiones${node ? ` (pasa por «${label(node)}»)` : ""}. Para repetir usa «Control de Flujo → Reiniciar» o «Repetir pregunta».`,
      nodeId: cycleAt ?? undefined,
    });
  }

  // --- Nodos inalcanzables desde Inicio (warning) ---
  if (start) {
    const reachable = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const next of adjacency.get(id) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        warnings.push({
          code: "UNREACHABLE_NODE",
          message: `«${label(node)}» no está conectado al flujo (nunca se ejecutará).`,
          nodeId: node.id,
        });
      }
    }
  }

  return { errors, warnings };
}

function validateTimeout(
  node: FlowNode,
  timeoutMinutes: number | undefined,
  edgeFrom: (nodeId: string, handle: string) => FlowEdge | undefined,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
): void {
  const hasTimeoutEdge = Boolean(edgeFrom(node.id, "timeout"));
  const minutes = timeoutMinutes ?? 0;
  if (hasTimeoutEdge && minutes <= 0) {
    errors.push({
      code: "TIMEOUT_WITHOUT_MINUTES",
      message: "Hay una conexión de «sin responder» pero el bloque no tiene minutos de espera configurados.",
      nodeId: node.id,
    });
  }
  if (!hasTimeoutEdge && minutes > 0) {
    warnings.push({
      code: "TIMEOUT_WITHOUT_EDGE",
      message: `El bloque espera ${minutes} min sin respuesta pero esa salida no está conectada.`,
      nodeId: node.id,
    });
  }
}
