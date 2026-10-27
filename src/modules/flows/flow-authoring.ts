/**
 * Autoría de flujos compartida entre el copiloto del editor visual
 * (flows.copilot.ts, que propone y NO guarda) y el copiloto del panel / MCP
 * (copilot.controller.ts, que crea y edita flujos por chat).
 *
 * Aquí viven: la documentación de bloques y reglas que se le enseñan al
 * modelo, el contexto real del negocio (ids de CRM/etiquetas/servicios), la
 * resolución de nombres → ids, el auto-layout en servidor, la verificación de
 * referencias y el pipeline de normalización + validación de un borrador.
 */

import { prisma } from "../../lib/prisma";
import { flowNodeSchema, flowEdgeSchema, flowTriggerSchema } from "./flows.schemas";
import { validateFlow, type ValidationIssue } from "./flow-validation";
import { validationOptions } from "./flows.service";
import {
  DEFAULT_TRIGGER,
  type AnswersData,
  type BookAppointmentData,
  type ConditionData,
  type CrmMoveData,
  type CrmTagsData,
  type FlowControlData,
  type FlowEdge,
  type FlowNode,
  type FlowTrigger,
  type HandoffData,
  type ListData,
  type QuestionData,
  type SendTextData,
  type ToAgentData,
  type ValidatePaymentData,
} from "./flow-types";

// ---------------------------------------------------------------------------
// Documentación compacta de los bloques (espejo de flow-types.ts). Mantener en
// sincronía si se agregan tipos de nodo.
// ---------------------------------------------------------------------------
export const NODE_DOCS = `BLOQUES DISPONIBLES (type → data → handles de salida para edges):
- start: data {} → salida "next". SIEMPRE debe existir exactamente UN nodo start (id "start").
- send-text: {text, saveVariable?} → "next" (sigue de inmediato) y "reply" (espera respuesta del cliente). El texto soporta {{variables}}.
- send-image | send-video | send-audio | send-document: {mediaUrl, fileName?, caption?} → "next" y "reply". Solo úsalos si el usuario tiene la URL del archivo; si no, sugiere que suba el archivo y prefiere send-text.
- answers: {message, options:[{id,label,detectText?,detectMode?:"contains"|"equals"|"starts_with"|"ends_with"}] (máx 15), showOptions? (default true), repeatOnNoMatch, noMatchMessage?, saveVariable?, timeoutMinutes?} → un handle "opt:<id de cada opción>" y "timeout" (solo si timeoutMinutes>0). QUÉ VE EL CLIENTE: el message (la pregunta sola) y DEBAJO, agregadas automáticamente, las opciones numeradas "1. <label>" + "Responde con el número de tu opción". NO escribas la lista dentro del message ni crees opciones para los números ("1","2"): se duplicarían. QUÉ ACEPTA como respuesta: el número de la opción, su label (igual o contenido), UNA PALABRA del label (ej. "ia" → Agente IA, "auto" → Automatización; si la palabra está en dos opciones repite el menú) y, si lo pones, detectText (sinónimos extra, opcional; ej. label "Página web", detectText "web"). saveVariable guarda el LABEL elegido (no el número). Una opción = una rama = un edge "opt:<id>". Máx 5-6 opciones por pregunta; para menús largos usa list. NO se envían botones de WhatsApp (es texto). showOptions:false solo si el message ya explica cómo responder (ej. "Responde SÍ o NO").
- list: {title?, body, footer?, sections:[{id,title,options:[{id,label,description?}]}], repeatOnNoMatch, noMatchMessage?, timeoutMinutes?} → "opt:<id de cada opción>" y "timeout". Menú numerado largo con secciones (el cliente ve *título*, body, "1. label — description" y el footer); acepta el número, el label o una palabra del label. Úsalo para 7+ opciones o cuando cada opción necesita descripción; para 2-6 opciones usa answers.
- question: {message, varType:"text"|"number"|"email"|"phone", saveVariable, invalidMessage?, timeoutMinutes?} → "next" (y "timeout" si timeoutMinutes>0). Pide un dato, lo valida y lo guarda en {{saveVariable}} (snake_case).
- condition: {source:"variable"|"tag"|"purchased", variable?, operator?:"equals"|"contains"|"not_empty"|"empty", value?, tagId?} → "yes" y "no". source=variable exige variable+operator; source=tag exige tagId.
- wait: {seconds} (1-120) → "next". Pausa corta entre mensajes.
- reminder: {steps:[{id,minutes,message}]} (máx 5, delays ACUMULATIVOS desde que el cliente deja de responder) → "next". Se cancela solo si el cliente responde.
- validate-payment: {amountMode:"fixed"|"product", amount? (si fixed), productId? (si product), instructions?, retryMessage?, reviewMessage?, timeoutMinutes? (default 60)} → "approved", "rejected", "review" y "timeout". Cobra (Yape/Plin/Mercado Pago según lo configurado) y valida el comprobante automáticamente.
- book-appointment: {productId? (servicio con agenda), introMessage?, noSlotsMessage?, saveVariable?, timeoutMinutes? (default 30)} → "booked", "no-slots" y "timeout". Ofrece horarios REALES de la agenda y agenda la cita; deja {{cita_fecha}}, {{cita_codigo}}, {{cita_calendario_google}}, {{cita_calendario_ics}} y {{cita_videollamada}} (enlace de Meet/Zoom del servicio o del negocio si la cita es online; el sistema ya envía solo un mensaje con el enlace de videollamada y los de calendario tras agendar).
- crm-move: {crmId, crmColumnId, crmColumnName?} → "next". Mueve al cliente a una columna del CRM.
- crm-add-tags | crm-remove-tags: {tagIds:[uuid]} → "next". Asigna/quita etiquetas.
- handoff: {clientText?, notifyText?} → SIN salidas (terminal). Pausa el bot y avisa a un asesor humano.
- to-agent: {clientText?, note?} → SIN salidas (terminal; SOLO con la empresa en modo HYBRID). El agente IA continúa la conversación con las variables del flujo como contexto; note = instrucción para el agente sobre este cliente (ej. "ya eligió servicio y presupuesto: presenta la ficha y ofrece la llamada"). Con clientText el agente entra con el siguiente mensaje del cliente; sin clientText responde de inmediato (si el bloque se alcanza por timeout, pon clientText).
- flow-control: {action:"restart"|"transfer", targetFlowId? (si transfer)} → SIN salidas (terminal). Reinicia este flujo o transfiere a otro.

VARIABLES: en cualquier texto puedes usar {{nombre}}, {{telefono}} y las guardadas con saveVariable (ej. {{correo}}).

DISPARADOR (trigger): {onAnyMessage, keywords[], onFirstMessageOfDay, onFirstMessageEver, reactivationMinutes, onAdLead, adEntryIds[]}. onAdLead = lead que llega desde un ANUNCIO de Meta (se dispara con su primer mensaje atribuido, tiene prioridad sobre keywords); adEntryIds restringe a anuncios del catálogo (vacío = cualquiera). Prioridad al competir: anuncio > keywords > primer mensaje de la vida > primer mensaje del día > cualquier mensaje.`;

export const HARD_RULES = `REGLAS OBLIGATORIAS al proponer un flujo:
1. Exactamente UN nodo start (id "start", data {}); su edge sale por "next" hacia el primer bloque.
2. IDs únicos con formato <tipo>-<sufijo de 6 caracteres> (ej. "send-text-k3f9a2", "answers-x81mq0"). Conserva los IDs de los nodos existentes que no cambies. IDs de opciones: "opt-<6 chars>".
3. Cada edge: {id:"e-<6 chars>", source:<id nodo>, sourceHandle:<handle VÁLIDO del nodo origen según su tipo y data>, target:<id nodo>}. Un handle solo puede tener UN edge.
4. Todo nodo debe ser alcanzable desde start. No dejes ramas de answers/list sin conectar (cada opción con su edge "opt:<id>").
5. Textos al cliente: español cálido y claro, emojis con moderación. Nada de datos inventados (precios, links).
6. LAYOUT: start en x=80. Cada paso avanza x en +300. Ramas paralelas se separan en y de a 160 (y base 240). Sin superposiciones.
7. Si el usuario pide modificar, parte del ESTADO ACTUAL del lienzo y conserva todo lo que no pidió cambiar (incluidas posiciones).
8. Usa SOLO los IDs reales del negocio listados abajo para productId, crmId, crmColumnId y tagIds. Si el dato que necesitas no existe (ej. no hay productos o no hay pagos configurados), NO inventes IDs: explícalo en el resumen y usa una alternativa (ej. handoff).
9. En el trigger: si el usuario no especifica cómo se dispara, usa keywords razonables según el tema del flujo y menciónalo en el resumen.
10. answers/list: UNA opción por rama, con label corto (≤ 25 caracteres) y legible porque el cliente lo ve numerado. NUNCA dupliques una opción para aceptar el número y la palabra (el número ya se acepta solo); detectText solo para sinónimos; el message es la pregunta sola, sin la lista de opciones.`;

/** Facilidades SOLO para crear_flujo / editar_flujo (chat y MCP). */
export const AUTHORING_HINTS = `FACILIDADES al usar crear_flujo / editar_flujo:
- "position" es OPCIONAL: si algún nodo no la trae, el servidor ordena todo el flujo automáticamente (BFS desde start). Si todos los nodos la traen, se respeta.
- Los ids de edge son opcionales (se generan) y sourceHandle vacío equivale a "next".
- Puedes referirte a datos del negocio POR NOMBRE (o por id): en crm-move usa {tablero, columna}; en crm-add-tags / crm-remove-tags usa {etiquetas:[nombres]}; en book-appointment y validate-payment usa {producto}; en condition con source "tag" usa {etiqueta}; en flow-control transfer usa {flujo}. El servidor los convierte a ids y rechaza con un error claro los que no existan (créalos antes con crear_etiqueta / crear_columna / crear_producto).
- En answers/list puedes omitir el id de cada opción (se genera "opt-xxxxxx"); si lo omites, en los edges usa sourceHandle "opt:<label exacto>" o "opt:<posición 1..n>" y el servidor los convierte a "opt:<id>". detectText es opcional.
- Variables de question/answers (saveVariable) quedan en la ficha del cliente y, en HYBRID, el agente IA las recibe; para que el dueño las reciba por WhatsApp, inclúyelas en el notifyText del handoff con {{variable}}.
- En el trigger puedes usar "anuncios": [descripciones o ids del catálogo de anuncios] en vez de adEntryIds (se convierten a ids; ver_catalogo_anuncios los lista). Si el dueño capta leads por Meta Ads, prefiere onAdLead a keywords.
- El flujo se guarda INACTIVO y el dueño puede revisarlo en /flujos/<id>; se enciende con activar_flujo.`;

/** Ejemplo completo y válido (forma exacta que espera crear_flujo). */
export const AUTHORING_EXAMPLE = `EJEMPLO COMPLETO (flujo de calificación de leads de anuncio, modo HYBRID; sin positions: se ordena solo):
{
  "nombre": "Calificación de leads Meta",
  "trigger": { "onAdLead": true },
  "nodes": [
    { "id": "start", "type": "start", "data": {} },
    { "id": "answers-serv01", "type": "answers", "data": {
        "message": "¡Hola {{nombre}}! 👋 Gracias por escribir. Para ayudarte mejor, ¿qué necesitas?",
        "options": [
          { "id": "opt-web001", "label": "Página web", "detectText": "web" },
          { "id": "opt-app001", "label": "App móvil", "detectText": "app" },
          { "id": "opt-bot001", "label": "Agente IA", "detectText": "bot" }
        ],
        "repeatOnNoMatch": true, "noMatchMessage": "No te entendí 🙈", "saveVariable": "servicio", "timeoutMinutes": 60 } },
    { "id": "crm-add-tags-web01", "type": "crm-add-tags", "data": { "etiquetas": ["Desarrollo web"] } },
    { "id": "crm-add-tags-app01", "type": "crm-add-tags", "data": { "etiquetas": ["App móvil"] } },
    { "id": "crm-add-tags-bot01", "type": "crm-add-tags", "data": { "etiquetas": ["Agente IA"] } },
    { "id": "question-proy01", "type": "question", "data": { "message": "Cuéntame en dos líneas qué quieres lograr 🙌", "varType": "text", "saveVariable": "proyecto" } },
    { "id": "crm-move-calif01", "type": "crm-move", "data": { "tablero": "Ventas", "columna": "Calificando" } },
    { "id": "to-agent-fin01", "type": "to-agent", "data": { "note": "Ya eligió {{servicio}} y describió su proyecto: no lo vuelvas a preguntar; resuelve dudas y ofrece agendar la Llamada de diagnóstico." } }
  ],
  "edges": [
    { "source": "start", "sourceHandle": "next", "target": "answers-serv01" },
    { "source": "answers-serv01", "sourceHandle": "opt:opt-web001", "target": "crm-add-tags-web01" },
    { "source": "answers-serv01", "sourceHandle": "opt:opt-app001", "target": "crm-add-tags-app01" },
    { "source": "answers-serv01", "sourceHandle": "opt:opt-bot001", "target": "crm-add-tags-bot01" },
    { "source": "answers-serv01", "sourceHandle": "timeout", "target": "to-agent-fin01" },
    { "source": "crm-add-tags-web01", "sourceHandle": "next", "target": "question-proy01" },
    { "source": "crm-add-tags-app01", "sourceHandle": "next", "target": "question-proy01" },
    { "source": "crm-add-tags-bot01", "sourceHandle": "next", "target": "question-proy01" },
    { "source": "question-proy01", "sourceHandle": "next", "target": "crm-move-calif01" },
    { "source": "crm-move-calif01", "sourceHandle": "next", "target": "to-agent-fin01" }
  ]
}
Lo que recibe el cliente en el bloque answers (la lista la agrega el sistema):
"¡Hola Ana! 👋 Gracias por escribir. Para ayudarte mejor, ¿qué necesitas?

1. Página web
2. App móvil
3. Agente IA

Responde con el número de tu opción 👆"
Si responde "2", "App móvil" o "quiero una app" entra por opt-app001 y {{servicio}} = "App móvil".`;

// ---------------------------------------------------------------------------
// Contexto del negocio (selects mínimos)
// ---------------------------------------------------------------------------
export async function buildBusinessContext(companyId: string): Promise<string> {
  const [company, products, crms, tags, paymentMethods, flows, ads] = await Promise.all([
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
    prisma.adCatalogEntry.findMany({ where: { companyId }, select: { id: true, description: true }, take: 30, orderBy: { sortOrder: "asc" } }),
  ]);

  const lines: string[] = [`Negocio: ${company?.name ?? "—"} (rubro ${company?.vertical ?? "OTHER"}).`];
  if (ads.length) {
    lines.push("Anuncios del catálogo (para adEntryIds del trigger onAdLead): " + ads.map((a) => `${a.description}=${a.id}`).join(", "));
  }
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

// ---------------------------------------------------------------------------
// Catálogo de referencias de la empresa (para resolver nombres y verificar ids)
// ---------------------------------------------------------------------------
interface Named {
  id: string;
  name: string;
}

interface RefCatalog {
  tags: Named[];
  boards: Named[];
  columns: Array<Named & { crmId: string }>;
  products: Array<Named & { durationMin: number | null }>;
  flows: Named[];
  /** Anuncios del catálogo: `name` = descripción. */
  ads: Named[];
}

async function loadRefCatalog(companyId: string): Promise<RefCatalog> {
  const [tags, boards, columns, products, flows, adRows] = await Promise.all([
    prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crm.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crmColumn.findMany({ where: { crm: { companyId } }, select: { id: true, name: true, crmId: true } }),
    prisma.product.findMany({ where: { companyId }, select: { id: true, name: true, durationMin: true } }),
    prisma.chatFlow.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.adCatalogEntry.findMany({ where: { companyId }, select: { id: true, description: true } }),
  ]);
  return { tags, boards, columns, products, flows, ads: adRows.map((a) => ({ id: a.id, name: a.description })) };
}

const norm = (v: string) => v.trim().toLowerCase();

function findNamed<T extends Named>(list: T[], ref: unknown): T | undefined {
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  return list.find((x) => x.id === ref || norm(x.name) === norm(ref));
}

type LooseNode = { id?: unknown; type?: unknown; position?: unknown; data?: unknown };

function nodeLabel(n: LooseNode, idx: number): string {
  return `nodo ${typeof n.id === "string" ? n.id : `#${idx}`} (${typeof n.type === "string" ? n.type : "?"})`;
}

/**
 * Convierte referencias por NOMBRE (tablero/columna/etiquetas/producto/etiqueta/
 * flujo) a ids en el `data` de cada nodo. Acepta también ids. Muta los nodos
 * recibidos (copias) y devuelve los errores encontrados (no lanza).
 */
function resolveFlowReferences(rawNodes: LooseNode[], cat: RefCatalog): { nodes: LooseNode[]; errors: string[] } {
  const errors: string[] = [];
  const nodes = rawNodes.map((n, idx) => {
    const data: Record<string, unknown> = { ...((n.data && typeof n.data === "object" ? n.data : {}) as Record<string, unknown>) };
    const label = nodeLabel(n, idx);
    switch (n.type) {
      case "crm-move": {
        let crmId = typeof data.crmId === "string" ? data.crmId : null;
        let crmColumnId = typeof data.crmColumnId === "string" ? data.crmColumnId : null;
        if (typeof data.tablero === "string" && data.tablero.trim()) {
          const b = findNamed(cat.boards, data.tablero);
          if (!b) errors.push(`${label}: el tablero «${data.tablero}» no existe (ver_crm lista los tableros)`);
          else crmId = b.id;
        }
        if (typeof data.columna === "string" && data.columna.trim()) {
          const cands = cat.columns.filter((c) => (crmId ? c.crmId === crmId : true));
          const c = findNamed(cands, data.columna);
          if (!c) errors.push(`${label}: la columna «${data.columna}» no existe${crmId ? " en ese tablero" : ""} (ver_crm lista las columnas)`);
          else {
            crmId = c.crmId;
            crmColumnId = c.id;
          }
        }
        delete data.tablero;
        delete data.columna;
        if (crmId) data.crmId = crmId;
        if (crmColumnId) {
          data.crmColumnId = crmColumnId;
          const col = cat.columns.find((c) => c.id === crmColumnId);
          if (col) data.crmColumnName = col.name;
        }
        break;
      }
      case "crm-add-tags":
      case "crm-remove-tags": {
        const ids = new Set<string>(Array.isArray(data.tagIds) ? (data.tagIds as unknown[]).filter((x): x is string => typeof x === "string") : []);
        if (Array.isArray(data.etiquetas)) {
          for (const ref of data.etiquetas as unknown[]) {
            const t = findNamed(cat.tags, ref);
            if (!t) errors.push(`${label}: la etiqueta «${String(ref)}» no existe (créala con crear_etiqueta)`);
            else ids.add(t.id);
          }
        }
        delete data.etiquetas;
        data.tagIds = [...ids];
        break;
      }
      case "book-appointment":
      case "validate-payment": {
        if (typeof data.producto === "string" && data.producto.trim()) {
          const p = findNamed(cat.products, data.producto);
          if (!p) errors.push(`${label}: el producto «${data.producto}» no existe (listar_productos)`);
          else data.productId = p.id;
        }
        delete data.producto;
        if (n.type === "validate-payment" && data.productId && !data.amountMode) data.amountMode = "product";
        break;
      }
      case "condition": {
        if (typeof data.etiqueta === "string" && data.etiqueta.trim()) {
          const t = findNamed(cat.tags, data.etiqueta);
          if (!t) errors.push(`${label}: la etiqueta «${data.etiqueta}» no existe (créala con crear_etiqueta)`);
          else {
            data.tagId = t.id;
            if (!data.source) data.source = "tag";
          }
        }
        delete data.etiqueta;
        break;
      }
      case "flow-control": {
        if (typeof data.flujo === "string" && data.flujo.trim()) {
          const f = findNamed(cat.flows, data.flujo);
          if (!f) errors.push(`${label}: el flujo «${data.flujo}» no existe (listar_flujos)`);
          else {
            data.targetFlowId = f.id;
            if (!data.action) data.action = "transfer";
          }
        }
        delete data.flujo;
        break;
      }
      default:
        break;
    }
    return { ...n, data };
  });
  return { nodes, errors };
}

/**
 * Verifica que los ids referenciados (CRM, columna, etiquetas, producto, flujo
 * destino) EXISTAN en la empresa. Ni zod ni validateFlow lo hacen (solo exigen
 * UUID), y un id ajeno dejaría un bloque que falla en silencio al ejecutarse.
 */
export async function checkFlowReferences(
  companyId: string,
  nodes: FlowNode[],
  catalog?: RefCatalog,
  trigger?: Partial<FlowTrigger> | null,
): Promise<string[]> {
  const cat = catalog ?? (await loadRefCatalog(companyId));
  const errors: string[] = [];
  for (const id of trigger?.adEntryIds ?? []) {
    if (!cat.ads.some((a) => a.id === id)) errors.push(`trigger: el anuncio ${id} no está en el catálogo de este negocio (ver_catalogo_anuncios)`);
  }
  for (const n of nodes) {
    const label = `nodo ${n.id} (${n.type})`;
    switch (n.type) {
      case "crm-move": {
        const d = n.data as CrmMoveData;
        const col = d.crmColumnId ? cat.columns.find((c) => c.id === d.crmColumnId) : undefined;
        if (d.crmId && !cat.boards.some((b) => b.id === d.crmId)) errors.push(`${label}: crmId no pertenece a este negocio`);
        if (d.crmColumnId && !col) errors.push(`${label}: crmColumnId no pertenece a este negocio`);
        if (col && d.crmId && col.crmId !== d.crmId) errors.push(`${label}: la columna no pertenece al tablero indicado`);
        break;
      }
      case "crm-add-tags":
      case "crm-remove-tags": {
        for (const id of (n.data as CrmTagsData).tagIds ?? []) {
          if (!cat.tags.some((t) => t.id === id)) errors.push(`${label}: la etiqueta ${id} no pertenece a este negocio`);
        }
        break;
      }
      case "condition": {
        const d = n.data as ConditionData;
        if (d.source === "tag" && d.tagId && !cat.tags.some((t) => t.id === d.tagId)) errors.push(`${label}: tagId no pertenece a este negocio`);
        break;
      }
      case "book-appointment": {
        const d = n.data as BookAppointmentData;
        const p = d.productId ? cat.products.find((x) => x.id === d.productId) : undefined;
        if (d.productId && !p) errors.push(`${label}: productId no pertenece a este negocio`);
        else if (p && !p.durationMin) errors.push(`${label}: el servicio «${p.name}» no tiene duración de cita (durationMin); configúrala con actualizar_producto`);
        break;
      }
      case "validate-payment": {
        const d = n.data as ValidatePaymentData;
        if (d.productId && !cat.products.some((x) => x.id === d.productId)) errors.push(`${label}: productId no pertenece a este negocio`);
        break;
      }
      case "flow-control": {
        const d = n.data as FlowControlData;
        if (d.action === "transfer" && d.targetFlowId && !cat.flows.some((f) => f.id === d.targetFlowId)) {
          errors.push(`${label}: targetFlowId no pertenece a este negocio`);
        }
        break;
      }
      default:
        break;
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Auto-layout por niveles (port del "Ordenar" del editor: BFS desde start
// define la columna x; dentro de cada columna se apilan en y centrados).
// ---------------------------------------------------------------------------
export function autoLayoutFlow<T extends { id: string; type?: unknown; position?: unknown }>(
  nodes: T[],
  edges: Array<{ source: string; target: string }>,
): Array<T & { position: { x: number; y: number } }> {
  if (!nodes.length) return [];
  const adj = new Map<string, string[]>();
  edges.forEach((e) => {
    const arr = adj.get(e.source) ?? [];
    arr.push(e.target);
    adj.set(e.source, arr);
  });
  const level = new Map<string, number>();
  const startId = nodes.find((n) => n.type === "start")?.id ?? nodes[0].id;
  const queue: Array<{ id: string; lvl: number }> = [{ id: startId, lvl: 0 }];
  while (queue.length) {
    const { id, lvl } = queue.shift()!;
    if (level.has(id) && level.get(id)! <= lvl) continue;
    level.set(id, lvl);
    (adj.get(id) ?? []).forEach((t) => queue.push({ id: t, lvl: lvl + 1 }));
  }
  const maxLvl = level.size ? Math.max(...level.values()) : 0;
  nodes.forEach((n) => {
    if (!level.has(n.id)) level.set(n.id, maxLvl + 1);
  });
  const byLevel = new Map<number, string[]>();
  nodes.forEach((n) => {
    const l = level.get(n.id)!;
    const arr = byLevel.get(l) ?? [];
    arr.push(n.id);
    byLevel.set(l, arr);
  });
  const X0 = 80;
  const DX = 300;
  const DY = 150;
  const maxCount = Math.max(...[...byLevel.values()].map((a) => a.length));
  const totalH = (maxCount - 1) * DY;
  const pos = new Map<string, { x: number; y: number }>();
  byLevel.forEach((ids, l) => {
    const colH = (ids.length - 1) * DY;
    const offsetY = (totalH - colH) / 2;
    ids.forEach((id, i) => pos.set(id, { x: X0 + l * DX, y: 240 + offsetY + i * DY }));
  });
  return nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? { x: X0, y: 240 } }));
}

function hasPosition(n: { position?: unknown }): boolean {
  const p = n.position as { x?: unknown; y?: unknown } | undefined;
  return !!p && typeof p.x === "number" && typeof p.y === "number";
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

// ---------------------------------------------------------------------------
// Pipeline: borrador laxo → flujo validado listo para guardar
// ---------------------------------------------------------------------------
export interface FlowDraftInput {
  trigger?: unknown;
  nodes?: unknown;
  edges?: unknown;
}

export type NormalizedFlowDraft =
  | { ok: true; trigger: FlowTrigger; nodes: FlowNode[]; edges: FlowEdge[]; warnings: string[] }
  | { ok: false; errors: string[] };

const MAX_ERRORS = 20;

function issueText(i: ValidationIssue): string {
  return `${i.nodeId ? `nodo ${i.nodeId}: ` : i.edgeId ? `edge ${i.edgeId}: ` : ""}${i.message}`;
}

/**
 * Normaliza y valida un borrador recibido por chat/MCP:
 * trigger → ids de edge faltantes → nombres→ids → layout → zod → validateFlow
 * → referencias. Devuelve el flujo listo para updateFlow o los errores.
 */
export async function normalizeFlowDraft(companyId: string, raw: FlowDraftInput): Promise<NormalizedFlowDraft> {
  const errors: string[] = [];
  const catalog = await loadRefCatalog(companyId);

  // Trigger: "anuncios" (descripciones o ids del catálogo) → adEntryIds.
  const rawTrigger: Record<string, unknown> = { ...((raw.trigger && typeof raw.trigger === "object" ? raw.trigger : {}) as Record<string, unknown>) };
  if (Array.isArray(rawTrigger.anuncios)) {
    const ids = new Set<string>(Array.isArray(rawTrigger.adEntryIds) ? (rawTrigger.adEntryIds as unknown[]).filter((x): x is string => typeof x === "string") : []);
    for (const ref of rawTrigger.anuncios as unknown[]) {
      const a = findNamed(catalog.ads, ref);
      if (!a) errors.push(`trigger: el anuncio «${String(ref)}» no está en el catálogo (ver_catalogo_anuncios / configurar_anuncio)`);
      else ids.add(a.id);
    }
    rawTrigger.adEntryIds = [...ids];
    if (ids.size && rawTrigger.onAdLead === undefined) rawTrigger.onAdLead = true;
  }
  delete rawTrigger.anuncios;
  const trigResult = flowTriggerSchema.safeParse(rawTrigger);
  const trigger = trigResult.success ? trigResult.data : DEFAULT_TRIGGER;
  if (!trigResult.success) {
    errors.push("trigger inválido: " + trigResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }

  const rawNodes = (Array.isArray(raw.nodes) ? raw.nodes : []) as LooseNode[];
  const rawEdges = (Array.isArray(raw.edges) ? raw.edges : []) as Array<Record<string, unknown>>;
  if (!rawNodes.length) errors.push("nodes está vacío");
  if (rawNodes.length > 200) errors.push("máximo 200 nodos");
  if (rawEdges.length > 500) errors.push("máximo 500 edges");
  if (errors.length) return { ok: false, errors };

  // Nombres → ids (tablero/columna/etiquetas/producto/flujo).
  const resolved = resolveFlowReferences(rawNodes, catalog);
  errors.push(...resolved.errors);

  // Layout: si falta alguna posición se reordena TODO (posiciones parciales
  // se superpondrían); si todas vienen, se respetan.
  const edgesForLayout = rawEdges
    .filter((e) => typeof e.source === "string" && typeof e.target === "string")
    .map((e) => ({ source: e.source as string, target: e.target as string }));
  const withIds = resolved.nodes.map((n) => ({ ...n, id: typeof n.id === "string" && n.id ? n.id : `${String(n.type ?? "node")}-${randomSuffix()}` }));
  // Opciones de answers/list sin id → "opt-xxxxxx"; los edges que apunten a
  // "opt:<label>" u "opt:<posición>" se convierten a "opt:<id>".
  const handleRemap = new Map<string, Map<string, string>>(); // nodeId → (alias → handle real)
  for (const n of withIds) {
    const data = (n as { data?: Record<string, unknown> }).data;
    if (!data || (n.type !== "answers" && n.type !== "list")) continue;
    const aliases = new Map<string, string>();
    let pos = 0;
    const fix = (opt: Record<string, unknown>) => {
      pos += 1;
      if (typeof opt.id !== "string" || !opt.id) opt.id = `opt-${randomSuffix()}`;
      const id = opt.id as string;
      aliases.set(`opt:${pos}`, `opt:${id}`);
      if (typeof opt.label === "string" && opt.label.trim()) aliases.set(`opt:${opt.label.trim().toLowerCase()}`, `opt:${id}`);
    };
    if (n.type === "answers" && Array.isArray(data.options)) {
      for (const o of data.options as unknown[]) if (o && typeof o === "object") fix(o as Record<string, unknown>);
    }
    if (n.type === "list" && Array.isArray(data.sections)) {
      for (const sec of data.sections as unknown[]) {
        const sd = sec as Record<string, unknown> | null;
        if (sd && typeof sd === "object") {
          if (typeof sd.id !== "string" || !sd.id) sd.id = `sec-${randomSuffix()}`;
          if (Array.isArray(sd.options)) for (const o of sd.options as unknown[]) if (o && typeof o === "object") fix(o as Record<string, unknown>);
        }
      }
    }
    if (aliases.size) handleRemap.set(n.id as string, aliases);
  }
  for (const e of rawEdges) {
    const h = typeof e.sourceHandle === "string" ? e.sourceHandle : "";
    const map = typeof e.source === "string" ? handleRemap.get(e.source) : undefined;
    if (!map || !h.startsWith("opt:")) continue;
    const real = map.get(h) ?? map.get(h.toLowerCase());
    if (real) e.sourceHandle = real;
  }
  const allPositioned = withIds.every(hasPosition);
  const positioned = allPositioned ? withIds : autoLayoutFlow(withIds as Array<{ id: string; type?: unknown; position?: unknown }>, edgesForLayout);

  const nodes: FlowNode[] = [];
  positioned.forEach((n, idx) => {
    const r = flowNodeSchema.safeParse(n);
    if (r.success) nodes.push(r.data as FlowNode);
    else errors.push(`${nodeLabel(n, idx)}: ` + r.error.issues.map((i) => `${i.path.join(".") || "raíz"} → ${i.message}`).join("; "));
  });

  const edges: FlowEdge[] = [];
  rawEdges.forEach((e, idx) => {
    const candidate = {
      ...e,
      id: typeof e.id === "string" && e.id ? e.id : `e-${randomSuffix()}`,
      sourceHandle: typeof e.sourceHandle === "string" && e.sourceHandle ? e.sourceHandle : "next",
    };
    const r = flowEdgeSchema.safeParse(candidate);
    if (r.success) {
      const parsed = r.data as FlowEdge;
      edges.push({ ...parsed, sourceHandle: parsed.sourceHandle || "next" });
    } else {
      errors.push(`edge #${idx}: ` + r.error.issues.map((i) => `${i.path.join(".")} → ${i.message}`).join("; "));
    }
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };

  const result = validateFlow(nodes, edges, await validationOptions(companyId));
  if (result.errors.length) return { ok: false, errors: result.errors.map(issueText).slice(0, MAX_ERRORS) };

  const refErrors = await checkFlowReferences(companyId, nodes, catalog, trigger);
  if (refErrors.length) return { ok: false, errors: refErrors.slice(0, MAX_ERRORS) };

  return { ok: true, trigger, nodes, edges, warnings: result.warnings.map(issueText) };
}

// ---------------------------------------------------------------------------
// Resumen legible de un flujo (ids → nombres) para el dueño
// ---------------------------------------------------------------------------
export function describeTrigger(trigger: unknown): string {
  const t = (trigger && typeof trigger === "object" ? trigger : {}) as Partial<FlowTrigger>;
  const parts: string[] = [];
  if (t.onAnyMessage) parts.push("cualquier mensaje");
  if (t.keywords?.length) parts.push(`palabras clave: ${t.keywords.map((k) => `«${k}»`).join(", ")}`);
  if (t.onFirstMessageOfDay) parts.push("primer mensaje del día");
  if (t.onFirstMessageEver) parts.push("primer mensaje de un cliente nuevo");
  if (t.onAdLead) parts.push(`lead que llega desde un anuncio de Meta (primer mensaje)${t.adEntryIds?.length ? ` · solo ${t.adEntryIds.length} anuncio(s) del catálogo` : ""}`);
  if (!parts.length) parts.push("SIN disparador (no se activará solo)");
  if (t.reactivationMinutes) parts.push(`no se repite antes de ${t.reactivationMinutes} min`);
  return parts.join(" · ");
}

export async function describeFlow(
  companyId: string,
  flow: { id: string; name: string; isActive: boolean; trigger: unknown; nodes: unknown; edges: unknown },
): Promise<string> {
  const cat = await loadRefCatalog(companyId);
  const nodes = (Array.isArray(flow.nodes) ? flow.nodes : []) as FlowNode[];
  const edges = (Array.isArray(flow.edges) ? flow.edges : []) as FlowEdge[];
  const nameOf = (list: Named[], id: unknown) => (typeof id === "string" ? list.find((x) => x.id === id)?.name ?? `?(${id.slice(0, 8)})` : "?");
  const short = (s: unknown, n = 90) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, FlowEdge[]>();
  edges.forEach((e) => out.set(e.source, [...(out.get(e.source) ?? []), e]));

  // Orden BFS desde start para que el resumen siga el recorrido del cliente.
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [nodes.find((n) => n.type === "start")?.id ?? nodes[0]?.id].filter(Boolean) as string[];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    (out.get(id) ?? []).forEach((e) => queue.push(e.target));
  }
  nodes.forEach((n) => {
    if (!seen.has(n.id)) order.push(n.id);
  });

  const describeNode = (n: FlowNode): string => {
    const d = n.data as Record<string, unknown>;
    switch (n.type) {
      case "start":
        return "Inicio";
      case "send-text":
        return `Mensaje: «${short((n.data as SendTextData).text)}»`;
      case "send-image":
      case "send-video":
      case "send-audio":
      case "send-document":
        return `Multimedia (${n.type.replace("send-", "")})${d.caption ? `: «${short(d.caption)}»` : ""}`;
      case "answers": {
        const a = n.data as AnswersData;
        const opts = (a.options ?? []).map((o, i) => {
          const e = (out.get(n.id) ?? []).find((x) => x.sourceHandle === `opt:${o.id}`);
          return `${i + 1}) ${o.label || o.detectText} → ${e ? e.target : "SIN RAMA"}`;
        });
        const shown = a.showOptions === false ? " (opciones NO se listan: el mensaje debe decir cómo responder)" : " (el cliente las ve numeradas y responde con número o nombre)";
        return `Pregunta con opciones${shown}: «${short(a.message)}» · ${opts.join(" | ")}`;
      }
      case "list": {
        const l = n.data as ListData;
        const opts = (l.sections ?? []).flatMap((s) => (s.options ?? []).map((o) => o.label));
        return `Menú numerado: «${short(l.body)}» · opciones: ${opts.join(", ")}`;
      }
      case "question": {
        const q = n.data as QuestionData;
        return `Pregunta (${q.varType}) guarda {{${q.saveVariable}}}: «${short(q.message)}»`;
      }
      case "condition": {
        const c = n.data as ConditionData;
        if (c.source === "tag") return `Condición: tiene etiqueta «${nameOf(cat.tags, c.tagId)}»`;
        if (c.source === "purchased") return "Condición: ya compró";
        return `Condición: {{${c.variable}}} ${c.operator ?? ""} ${c.value ?? ""}`.trim();
      }
      case "wait":
        return `Espera ${String(d.seconds)}s`;
      case "reminder":
        return `Recordatorios si no responde (${Array.isArray(d.steps) ? (d.steps as unknown[]).length : 1} paso(s))`;
      case "validate-payment": {
        const v = n.data as ValidatePaymentData;
        return `Cobro y validación de pago (${v.amountMode === "fixed" ? `monto ${String(v.amount)}` : `producto «${nameOf(cat.products, v.productId)}»`})`;
      }
      case "book-appointment":
        return `Agendar cita: «${nameOf(cat.products, (n.data as BookAppointmentData).productId)}»`;
      case "crm-move": {
        const m = n.data as CrmMoveData;
        return `Mover en CRM → tablero «${nameOf(cat.boards, m.crmId)}», columna «${nameOf(cat.columns, m.crmColumnId)}»`;
      }
      case "crm-add-tags":
        return `Etiquetar: ${((n.data as CrmTagsData).tagIds ?? []).map((id) => `«${nameOf(cat.tags, id)}»`).join(", ")}`;
      case "crm-remove-tags":
        return `Quitar etiquetas: ${((n.data as CrmTagsData).tagIds ?? []).map((id) => `«${nameOf(cat.tags, id)}»`).join(", ")}`;
      case "handoff": {
        const h = n.data as HandoffData;
        return `Derivar a humano (bot pausado)${h.notifyText ? ` · aviso al dueño: «${short(h.notifyText)}»` : " · aviso genérico al dueño"}`;
      }
      case "flow-control": {
        const f = n.data as FlowControlData;
        return f.action === "transfer" ? `Transferir al flujo «${nameOf(cat.flows, f.targetFlowId)}»` : "Reiniciar este flujo";
      }
      case "to-agent": {
        const t = n.data as ToAgentData;
        return `Pasar al agente IA${t.clientText ? ` · transición: «${short(t.clientText)}»` : " (responde de inmediato)"}${t.note ? ` · instrucción: «${short(t.note)}»` : ""}`;
      }
      default:
        return n.type;
    }
  };

  const lines = order.map((id, i) => {
    const n = byId.get(id);
    if (!n) return `${i + 1}. [${id}] (nodo faltante)`;
    const nexts = (out.get(id) ?? [])
      .filter((e) => !e.sourceHandle.startsWith("opt:"))
      .map((e) => `${e.sourceHandle}→${e.target}`);
    return `${i + 1}. [${n.id}] ${describeNode(n)}${nexts.length ? ` ⇒ ${nexts.join(", ")}` : ""}`;
  });

  return [
    `Flujo «${flow.name}» (${flow.isActive ? "ACTIVO" : "inactivo"}) · disparador: ${describeTrigger(flow.trigger)} · ${Math.max(0, nodes.length - 1)} bloque(s)`,
    ...lines,
    `Editar en el panel: /flujos/${flow.id}`,
  ].join("\n");
}
