/**
 * Tipos del flow builder (compartidos conceptualmente con el frontend, que
 * mantiene un espejo en src/shared/features/flows/flow-types.ts).
 *
 * Los nodos/aristas se guardan en formato React Flow para cargar/guardar
 * directo desde el editor.
 */

export interface FlowTrigger {
  onAnyMessage: boolean;
  /** Frases/palabras; match "contiene", case/acento-insensible. */
  keywords: string[];
  onFirstMessageOfDay: boolean;
  onFirstMessageEver: boolean;
  /** El mismo flujo no se re-dispara para el mismo cliente antes de este intervalo. 0 = sin restricción. */
  reactivationMinutes: number;
}

export const DEFAULT_TRIGGER: FlowTrigger = {
  onAnyMessage: false,
  keywords: [],
  onFirstMessageOfDay: false,
  onFirstMessageEver: false,
  reactivationMinutes: 0,
};

export type FlowNodeType =
  | "start"
  | "send-text"
  | "send-image"
  | "send-video"
  | "send-audio"
  | "send-document"
  | "answers"
  | "list"
  | "flow-control"
  | "handoff"
  | "reminder";

export type DetectMode = "contains" | "equals" | "starts_with" | "ends_with";

export interface SendTextData {
  text: string;
  saveVariable?: string;
}

export interface SendMediaData {
  mediaUrl: string;
  /** Nombre de archivo (documentos). */
  fileName?: string;
  /** Texto/caption que acompaña; soporta {{variables}}. */
  caption?: string;
  saveVariable?: string;
}

export interface AnswersOption {
  id: string;
  /** Etiqueta visible en el editor (y texto sugerido al cliente). */
  label: string;
  /** Texto a detectar en la respuesta del cliente. */
  detectText: string;
  detectMode: DetectMode;
}

export interface AnswersData {
  message: string;
  options: AnswersOption[];
  /** Si la respuesta no matchea ninguna opción, repetir la pregunta. */
  repeatOnNoMatch: boolean;
  noMatchMessage?: string;
  saveVariable?: string;
  /** >0 habilita la salida "timeout" (N minutos sin responder). */
  timeoutMinutes?: number;
}

export interface ListOption {
  id: string;
  label: string;
  description?: string;
}

export interface ListSection {
  id: string;
  title: string;
  options: ListOption[];
}

/** Menú numerado emulado (SMS Tools no soporta listas interactivas de WA). */
export interface ListData {
  title?: string;
  body: string;
  footer?: string;
  sections: ListSection[];
  repeatOnNoMatch: boolean;
  noMatchMessage?: string;
  saveVariable?: string;
  timeoutMinutes?: number;
}

export interface FlowControlData {
  action: "restart" | "transfer";
  targetFlowId?: string;
}

export interface HandoffData {
  /** Aviso al dueño; default genérico. */
  notifyText?: string;
}

export interface ReminderData {
  minutes: number;
  message: string;
}

export type FlowNodeData =
  | SendTextData
  | SendMediaData
  | AnswersData
  | ListData
  | FlowControlData
  | HandoffData
  | ReminderData
  | Record<string, never>;

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  data: FlowNodeData;
}

/**
 * sourceHandle: "next" (llamar al siguiente bloque) | "reply" (cuando responda)
 *   | `opt:<optionId>` (opción de answers/list) | "timeout" (N min sin responder).
 */
export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle?: string | null;
}

export const SEND_NODE_TYPES: FlowNodeType[] = [
  "send-text",
  "send-image",
  "send-video",
  "send-audio",
  "send-document",
];

export const TERMINAL_NODE_TYPES: FlowNodeType[] = ["flow-control", "handoff"];

export function isSendNode(type: string): boolean {
  return SEND_NODE_TYPES.includes(type as FlowNodeType);
}

/** Handles de salida válidos para un nodo según su tipo y data. */
export function outputHandlesFor(node: FlowNode): string[] {
  switch (node.type) {
    case "start":
      return ["next"];
    case "send-text":
    case "send-image":
    case "send-video":
    case "send-audio":
    case "send-document":
      return ["next", "reply"];
    case "answers": {
      const data = node.data as AnswersData;
      const opts = (data.options ?? []).map((o) => `opt:${o.id}`);
      return [...opts, "timeout"];
    }
    case "list": {
      const data = node.data as ListData;
      const opts = (data.sections ?? []).flatMap((s) => (s.options ?? []).map((o) => `opt:${o.id}`));
      return [...opts, "timeout"];
    }
    case "reminder":
      return ["next"];
    case "flow-control":
    case "handoff":
      return [];
    default:
      return [];
  }
}

/** Opciones planas (con numeración global 1..N) de un nodo list. */
export function flattenListOptions(data: ListData): Array<ListOption & { number: number; sectionTitle: string }> {
  const out: Array<ListOption & { number: number; sectionTitle: string }> = [];
  let n = 0;
  for (const section of data.sections ?? []) {
    for (const opt of section.options ?? []) {
      n += 1;
      out.push({ ...opt, number: n, sectionTitle: section.title });
    }
  }
  return out;
}
