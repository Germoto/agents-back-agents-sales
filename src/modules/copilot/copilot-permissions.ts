/**
 * Candado de confirmación del Copiloto del panel.
 *
 * El modelo NO decide si una escritura se ejecuta: cada llamada pasa por
 * `gateFor`. La clasificación es cerrada: lo que no figura como lectura ni como
 * escritura libre se trata como escritura con candado, así una herramienta
 * nueva nace protegida.
 *
 * El conector MCP no usa este módulo (Claude.ai ya pide permiso por llamada).
 */
import { randomBytes } from "crypto";

export type CopilotPermission = "consulta" | "confirmar" | "auto";
export type CopilotGate = "run" | "ask" | "deny";
type Args = Record<string, unknown>;

/** Solo leen: nunca piden confirmación. */
const READ_TOOLS = new Set([
  "listar_productos", "ver_producto", "previsualizar_ficha", "ver_configuracion", "ver_crm", "ver_respuestas_rapidas",
  "ver_tienda", "listar_campanas_correo", "previsualizar_audiencia_correo", "ver_cupones", "ver_metricas", "listar_ventas",
  "listar_comprobantes", "listar_pedidos", "listar_conversaciones", "leer_conversacion", "ver_cliente", "buscar_agencias",
  "listar_citas", "ver_catalogo_anuncios", "ver_eventos_meta", "listar_campanas", "previsualizar_audiencia_campana", "ver_campana",
  "ver_inventario_streaming", "listar_flujos", "ver_bloques_flujo", "ver_flujo", "listar_suscripciones",
  "listar_recordatorios_programados", "buscar_en_drive", "obtener_muestra", "listar_recursos", "ver_mi_plan",
  "ver_grupos_whatsapp", "ver_info_grupo", "leer_chat_grupo", "listar_acciones_http",
  // Interfaz: el panel las dibuja, no guardan nada.
  "proponer_productos", "proponer_formulario", "ofrecer_opciones", "mostrar_grafico",
]);

/** Escrituras inofensivas y fáciles de deshacer: pasan sin tarjeta. */
const FREE_WRITES = new Set(["agregar_nota_cliente", "fijar_conversacion", "adjuntar_foto_producto", "transcribir_audio", "crear_enlace_subida"]);

/** Irreversibles o que salen a mucha gente: preguntan SIEMPRE, también en modo automático. */
const ALWAYS_ASK = new Set([
  "eliminar_producto", "eliminar_archivo_producto", "eliminar_crm", "eliminar_columna", "eliminar_etiqueta",
  "eliminar_respuesta_rapida", "eliminar_pedido_tienda", "eliminar_cliente", "eliminar_campana",
  "iniciar_campana", "reanudar_campana", "cancelar_campana", "reiniciar_conversacion", "iniciar_conversacion",
  "sacar_de_grupo", "enviar_mensaje_grupo", "cancelar_recordatorios",
]);

/** Herramientas con freno propio (`confirmar`): al ejecutarse desde la tarjeta ya van confirmadas. */
const OWN_CONFIRM = new Set(["eliminar_archivo_producto", "configurar_mensaje_invitacion_grupo", "configurar_ritmo_grupos"]);

/** Llamadas de solo lectura de herramientas que también escriben. */
export function isReadCall(name: string, args: Args): boolean {
  if (READ_TOOLS.has(name)) return true;
  switch (name) {
    case "cancelar_recordatorios":
    case "agregar_a_grupo_whatsapp":
      return args.soloContar === true;
    case "crear_flujo":
    case "editar_flujo":
      return args.soloValidar === true;
    case "configurar_reportes": {
      const d = args.data;
      const hasData = Boolean(d && typeof d === "object" && Object.keys(d as Args).length);
      return !hasData && !args.prueba;
    }
    case "configurar_mensaje_invitacion_grupo":
      return args.apagar !== true && !(typeof args.mensaje === "string" && args.mensaje.trim());
    case "configurar_voz_agente":
      // Sin argumentos solo muestra la configuración y las voces.
      return !Object.values(args).some((v) => v !== undefined && v !== null);
    case "configurar_ritmo_grupos":
      return args.restablecer !== true && args.porMinuto === undefined && args.porHora === undefined && args.porDia === undefined;
    case "ver_miembros_grupo":
      return args.accion !== "reintentar" && args.accion !== "cancelar_pendientes";
    case "bloquear_horario":
      return args.listar === true && !args.quitarId && !args.inicio;
    default:
      return false;
  }
}

function isIrreversible(name: string, args: Args): boolean {
  if (ALWAYS_ASK.has(name)) return true;
  if (name === "configurar_anuncio") return args.eliminar === true;
  if (name === "actualizar_inventario_streaming") return args.accion === "eliminar";
  if (name === "gestionar_suscripcion") return args.accion === "cancelar";
  if (name === "guardar_grupo_whatsapp") return args.quitar === true;
  if (name === "ver_miembros_grupo") return args.accion === "cancelar_pendientes";
  return false;
}

/** Qué hacer con una llamada según el modo elegido por el dueño. */
export function gateFor(name: string, args: Args, permiso: CopilotPermission): CopilotGate {
  if (isReadCall(name, args)) return "run";
  if (permiso === "consulta") return "deny";
  if (FREE_WRITES.has(name)) return "run";
  if (permiso === "auto" && !isIrreversible(name, args)) return "run";
  return "ask";
}

/** ¿Se puede reintentar sin tarjeta una acción confirmada que falló? Nunca las irreversibles. */
export function canRetryConfirmed(name: string, args: Args): boolean {
  return !isIrreversible(name, args);
}

/** Argumentos con los que se ejecuta una acción ya confirmada en la tarjeta. */
export function confirmedArgs(tool: string, args: Args): Args {
  return OWN_CONFIRM.has(tool) ? { ...args, confirmar: true } : args;
}

// ---------------------------------------------------------------------------
// Tarjeta de confirmación
// ---------------------------------------------------------------------------
export interface ConfirmCardItem {
  id: string;
  titulo: string;
  detalle: { campo: string; valor: string }[];
  /** Irreversible o masiva: el panel la pinta en rojo. */
  riesgo: boolean;
}

const WORDS: Record<string, string> = { campana: "campaña", crm: "CRM", whatsapp: "WhatsApp", http: "HTTP", atencion: "atención", accion: "acción", conversacion: "conversación", cupon: "cupón", suscripcion: "suscripción", envios: "envíos", rapida: "rápida", pixel: "píxel" };
const DETAIL_MAX = 8;
const VALUE_MAX = 160;

function actionTitle(tool: string): string {
  const words = tool.split("_").map((w) => WORDS[w] ?? w);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function valueText(v: unknown): string {
  const raw = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 1)}…` : text;
}

/** Arma la tarjeta con los argumentos REALES que se van a ejecutar (no con lo que el modelo cuente). */
export function describeAction(p: PendingAction): ConfirmCardItem {
  const pairs: { campo: string; valor: string }[] = [];
  for (const [k, v] of Object.entries(p.args)) {
    if (v === undefined || v === null || k === "confirmar") continue;
    // `data`/`campos` se abren un nivel: ahí viaja lo que de verdad se guarda.
    if ((k === "data" || k === "campos") && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Args)) if (v2 !== undefined) pairs.push({ campo: k2, valor: valueText(v2) });
    } else {
      pairs.push({ campo: k, valor: valueText(v) });
    }
  }
  const detalle = pairs.slice(0, DETAIL_MAX);
  if (pairs.length > DETAIL_MAX) detalle.push({ campo: "…", valor: `y ${pairs.length - DETAIL_MAX} dato(s) más` });
  return { id: p.id, titulo: actionTitle(p.tool), detalle, riesgo: isIrreversible(p.tool, p.args) };
}

// ---------------------------------------------------------------------------
// Pendientes en memoria (el backend corre en una sola instancia)
// ---------------------------------------------------------------------------
export interface PendingAction {
  id: string;
  tool: string;
  args: Args;
  createdAt: number;
}

const PENDING_TTL_MS = 30 * 60_000;
export const PENDING_MAX_PER_TURN = 30;
const store = new Map<string, PendingAction[]>();

export function pendingKey(companyId: string, userId: string | undefined, kind: "panel" | "onboarding"): string {
  return `${companyId}:${userId ?? "-"}:${kind}`;
}

/**
 * Saca las pendientes del turno anterior. Valen SOLO para el mensaje siguiente:
 * lo que no se confirme en este turno se pierde (y un segundo clic ya no las encuentra).
 */
export function takePending(key: string): PendingAction[] {
  const items = store.get(key) ?? [];
  store.delete(key);
  const now = Date.now();
  return items.filter((p) => now - p.createdAt < PENDING_TTL_MS);
}

/** Guarda una acción propuesta en este turno. La misma llamada repetida reutiliza su tarjeta. */
export function addPending(key: string, tool: string, args: Args): PendingAction | null {
  const items = store.get(key) ?? [];
  const fingerprint = JSON.stringify(args);
  const same = items.find((p) => p.tool === tool && JSON.stringify(p.args) === fingerprint);
  if (same) return same;
  if (items.length >= PENDING_MAX_PER_TURN) return null;
  if (store.size > 2000) {
    const now = Date.now();
    for (const [k, list] of store) if (list.every((p) => now - p.createdAt >= PENDING_TTL_MS)) store.delete(k);
  }
  const pending: PendingAction = { id: randomBytes(4).toString("hex"), tool, args, createdAt: Date.now() };
  items.push(pending);
  store.set(key, items);
  return pending;
}
