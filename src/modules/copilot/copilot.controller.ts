/**
 * Copiloto de CONFIGURACIÓN del panel (Fase 1: productos + visión).
 *
 * Chat con la OpenAI key del TENANT donde el dueño configura su negocio
 * conversando (y enviando fotos de su carta/lista de precios). El modelo lee,
 * propone y — SOLO tras confirmación del usuario en la conversación — crea,
 * modifica o elimina productos vía los servicios existentes (validación y
 * scoping por companyId garantizados). Patrón heredado del copiloto de flujos.
 */

import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { chatCompletion, type ChatMessage, type ContentPart, type ToolDefinition } from "../../lib/openai";
import { productBodySchema } from "../products/products.schemas";
import { createProduct, updateProduct, deleteProduct, getProduct } from "../products/products.service";
import { updateBusinessProfile, type DeliveryConfigInput } from "../business/business.service";
import { upsertAgentConfig, updateAgentReminders } from "../agent-config/agent-config.service";
import { upsertPaymentConfig } from "../payment-config/payment-config.service";
import {
  createCrm,
  updateCrm,
  deleteCrm,
  createColumn,
  updateColumn,
  deleteColumn,
  reorderColumns,
  createTag,
  updateTag,
  deleteTag,
  applyCrmAndTagActions,
} from "../crm/crm.service";
import { updateWebchatConfig } from "../webchat/webchat.service";
import { followupConfigSchema } from "../agent-config/agent-config.schemas";
import {
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
  listCategories,
  createCategory,
} from "../quick-replies/quick-replies.service";
import { upsertQuickReplySchema } from "../quick-replies/quick-replies.schemas";
import { getBillingMe } from "../billing/billing.service";
import { getLivePlansPromptSection } from "../admin-console/sales-agent.service";
import { prepareImageUrl, resolveAiSettings } from "../../lib/ai-providers";

const MAX_ITERATIONS = 8;
const HISTORY_LIMIT = 16;

interface CopilotAttachment {
  url: string;
  storagePath: string;
  originalName: string;
  extension: string;
  mimeType: string;
  size: number;
  type: "IMAGE" | "PDF" | "VIDEO" | "AUDIO" | "OTHER";
}

interface CopilotBody {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    attachments?: CopilotAttachment[];
    /** Legado: solo URLs para visión. */
    imageUrls?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Tools (laxas — la validación real es zod/servicios al ejecutar)
// ---------------------------------------------------------------------------
const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "listar_productos",
      description: "Lista los productos actuales del negocio (resumen).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_producto",
      description: "Devuelve la ficha COMPLETA de un producto (para revisarla o antes de modificarla).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: { productId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_producto",
      description:
        "Crea UN producto (una llamada por producto). Llámala SOLO después de que el usuario CONFIRME tu propuesta. `data` sigue la guía de campos del rubro del system prompt.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: { type: "object", description: "Campos del producto según la guía del rubro (name y price obligatorios)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_producto",
      description:
        "Modifica un producto existente. `data` es PARCIAL y ADITIVO: las listas y objetos enviados (aliases, benefits, faqs, variants, attributes, verticalData...) se FUSIONAN con lo existente SIN borrar nada. Para QUITAR elementos o reescribir una lista, envía reemplazar=true con la versión FINAL completa (lee antes con ver_producto). Llámala SOLO tras la confirmación del usuario.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "data"],
        properties: {
          productId: { type: "string" },
          data: { type: "object", description: "Solo los campos a cambiar (aditivo por defecto)" },
          reemplazar: {
            type: "boolean",
            description: "true = las listas/objetos enviados REEMPLAZAN los existentes (para quitar o reescribir; envía la versión final completa)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_producto",
      description:
        "ELIMINA un producto definitivamente. Llámala SOLO si el usuario lo pidió y CONFIRMÓ explícitamente el nombre del producto a eliminar.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId"],
        properties: { productId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "adjuntar_foto_producto",
      description:
        "Deja una imagen ADJUNTADA EN ESTA CONVERSACIÓN como foto del producto. `url` debe ser EXACTAMENTE la de un adjunto del usuario. Con principal=true queda como foto principal (la primera del catálogo/ficha). Llámala tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "url"],
        properties: {
          productId: { type: "string" },
          url: { type: "string", description: "URL exacta de la imagen adjuntada por el usuario" },
          description: { type: "string", description: "Descripción del archivo (ayuda al agente a saber cuándo enviarlo)" },
          principal: { type: "boolean", description: "true = foto principal del producto" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_configuracion",
      description:
        "Devuelve la configuración ACTUAL del negocio: empresa (nombre, rubro, zona horaria, delivery, horario de atención), agente IA (prompt/estilo/reglas, sin credenciales) y pagos (métodos y modo). Úsala antes de proponer cambios.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_empresa",
      description:
        "Actualiza la EMPRESA. `data` es PARCIAL (solo lo que cambia): {name?, timezone?, vertical? (SOLO si aún no hay productos), botMode? ('AI'|'FLOW'), deliveryConfig? {cost?, time?, areas?: string[], pickupAvailable?, requiresAddress?}, businessHours? [{day (0=domingo..6=sábado), from 'HH:MM', to 'HH:MM'}], firmaEnabled?, firmaText?}. Llámala SOLO tras la confirmación del usuario.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: { type: "object", description: "Solo los campos a cambiar" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_agente",
      description:
        "Actualiza el AGENTE IA. `data` es PARCIAL: {basePrompt?, salesStyle? (cercano|profesional|directo|entusiasta|consultivo), rules?: string[] (se AGREGAN a las existentes; para quitar una usa reemplazarReglas=true con la lista final), negotiationHandoff?, catalogMode? (preguntar|resumen_humano|primeros_n), keywordMode? (detalle_y_preguntar|agregar_directo|auto), trackStock?, catalogMediaMode? (text|media|both)}. NUNCA gestiona la API key, el proveedor ni el modelo. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: { type: "object", description: "Solo los campos a cambiar" },
          reemplazarReglas: { type: "boolean", description: "true = rules enviadas REEMPLAZAN todas las existentes" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_crm",
      description: "Devuelve los tableros CRM actuales (con sus columnas) y las etiquetas del negocio.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_crm",
      description:
        "Crea un tablero CRM con sus columnas (embudo). Llámala SOLO tras la confirmación del usuario. Ej: nombre 'Ventas' con columnas ['Nuevos','Interesados','Pagados'].",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "columns"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          color: { type: "string", description: "Hex, ej. #6366f1 (opcional)" },
          columns: { type: "array", items: { type: "string" }, description: "Nombres de las columnas en orden" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_columna",
      description: "Agrega una columna a un tablero CRM existente (usa ver_crm para el crmId).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["crmId", "name"],
        properties: { crmId: { type: "string" }, name: { type: "string" }, color: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_etiqueta",
      description: "Crea una etiqueta de clientes (ej. 'VIP', 'Mayorista').",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" }, color: { type: "string", description: "Hex, default #6366f1" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_crm",
      description: "Renombra un tablero CRM o cambia su descripción/color (parcial: solo lo que envíes).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["crmId"],
        properties: {
          crmId: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          color: { type: "string", description: "Hex" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_crm",
      description:
        "ELIMINA un tablero CRM completo (los clientes no se borran, pero pierden su posición en ese embudo). SOLO tras confirmación explícita del nombre del tablero.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["crmId"],
        properties: { crmId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_columna",
      description: "Renombra una columna del CRM o cambia su color (parcial).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["crmId", "columnId"],
        properties: {
          crmId: { type: "string" },
          columnId: { type: "string" },
          name: { type: "string" },
          color: { type: "string", description: "Hex" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_columna",
      description:
        "ELIMINA una columna del CRM. Los clientes que estaban en ella VUELVEN al Inbox (avísalo al proponer). SOLO tras confirmación explícita.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["crmId", "columnId"],
        properties: { crmId: { type: "string" }, columnId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reordenar_columnas",
      description: "Reordena las columnas de un tablero. Pasa TODOS los columnIds en el orden final deseado.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["crmId", "columnIds"],
        properties: {
          crmId: { type: "string" },
          columnIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_etiqueta",
      description: "Renombra una etiqueta o cambia su color (parcial).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tagId"],
        properties: { tagId: { type: "string" }, name: { type: "string" }, color: { type: "string", description: "Hex" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_etiqueta",
      description:
        "ELIMINA una etiqueta (se desasigna de todos los clientes que la tenían — avísalo). SOLO tras confirmación explícita.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tagId"],
        properties: { tagId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_respuestas_rapidas",
      description: "Lista las respuestas rápidas del asesor (id, título, /comando, categoría, nº de mensajes) y sus categorías.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_respuesta_rapida",
      description:
        "Crea una RESPUESTA RÁPIDA (atajo que el asesor humano envía con un clic o escribiendo /comando en Conversaciones; el bot NO las envía solo). messages es la secuencia (1-10): texto {type:'text', text} o multimedia {type:'image'|'video'|'audio'|'document', mediaUrl (puede ser un adjunto de esta conversación), text? como caption}. Llámala tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "messages"],
        properties: {
          title: { type: "string" },
          command: { type: "string", description: "Atajo, ej. '/gracias' (opcional, único por negocio)" },
          category: { type: "string", description: "Nombre de la categoría (se crea si no existe)" },
          messages: { type: "array", items: { type: "object" }, description: "Secuencia de mensajes" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_respuesta_rapida",
      description:
        "Modifica una respuesta rápida. `data` es PARCIAL: {title?, command?, category?, messages?}. Los messages enviados se AGREGAN al final de la secuencia; para reescribirla o quitar mensajes usa reemplazarMensajes=true con la secuencia final completa. Llámala tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["quickReplyId", "data"],
        properties: {
          quickReplyId: { type: "string" },
          data: { type: "object", description: "Solo los campos a cambiar" },
          reemplazarMensajes: { type: "boolean", description: "true = messages enviados REEMPLAZAN la secuencia completa" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_respuesta_rapida",
      description: "ELIMINA una respuesta rápida. SOLO tras confirmación explícita del título/comando.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["quickReplyId"],
        properties: { quickReplyId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gestionar_cliente_crm",
      description:
        "Mueve un CLIENTE a una columna del CRM y/o le asigna/quita etiquetas. Identifica al cliente por su teléfono. Usa ver_crm para los ids de tablero/columna y los NOMBRES exactos de etiquetas.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone"],
        properties: {
          phone: { type: "string", description: "Teléfono del cliente (como aparece en Conversaciones/CRM)" },
          crmId: { type: "string" },
          columnId: { type: "string" },
          addTagNames: { type: "array", items: { type: "string" }, description: "Etiquetas EXISTENTES a asignar (por nombre)" },
          removeTagNames: { type: "array", items: { type: "string" }, description: "Etiquetas a quitar (por nombre)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_chat_web",
      description:
        "Actualiza el CHAT WEB embebible. `data` es PARCIAL: {enabled?, welcomeMessage?, accentColor? (hex), allowedOrigins?: string[] (los dominios enviados se AGREGAN a los existentes; para quitar uno usa reemplazarDominios=true con la lista final)}. El token del widget NO se gestiona por chat. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: { type: "object", description: "Solo los campos a cambiar" },
          reemplazarDominios: { type: "boolean", description: "true = allowedOrigins enviados REEMPLAZAN la lista completa" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_recordatorios",
      description:
        "Actualiza los RECORDATORIOS automáticos. `data` es PARCIAL: {abandonedCart? {enabled, steps: [{delaySeconds, message, offerPrice? (OFERTA ESCALONADA: al enviarse ese paso el agente ofrece/cobra/valida ese precio SOLO a ese cliente; usa {oferta} en el mensaje)}]}, leftOnRead? {enabled, steps: [...]}, quietHours? {startHour 0-23, endHour 1-24}}. delaySeconds en segundos (ej. 3600 = 1 hora). Escalera típica: paso 1 con oferta suave, paso 2 con mejor precio. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: { type: "object", description: "Solo los campos a cambiar" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_pagos",
      description:
        "Actualiza los PAGOS manuales. `data` es PARCIAL: {enabled?, notificationPhone? (WhatsApp donde avisar pagos), methods?: [{method (ej. 'Yape','Plin','BCP'), number, holder}] (se FUSIONAN por método+número: agrega nuevos y actualiza titulares; para QUITAR uno usa reemplazarMetodos=true con la lista final completa), paymentMode? (BEFORE_DELIVERY|CASH_ON_DELIVERY|MANUAL|CUSTOMER_CHOICE)}. Tokens de Mercado Pago NO (dirige a Pagos). Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: {
          data: { type: "object", description: "Solo los campos a cambiar" },
          reemplazarMetodos: { type: "boolean", description: "true = methods enviados REEMPLAZAN la lista completa" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_mi_plan",
      description:
        "Consulta el plan/suscripción ACTUAL de este negocio en FlowApp: plan contratado, estado, fecha de vencimiento, leads usados del mes, módulos incluidos y saldo de créditos. Úsala para preguntas como '¿cuándo vence mi plan?', '¿cuántos leads llevo?', '¿mi plan incluye CRM?'. Solo lectura.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
];

/** Resuelve la URL que pasa el modelo a un adjunto REAL de la conversación.
 * Tolerante: con proveedores que inlinean imágenes (data-URI, Claude/Gemini)
 * el modelo no ve la URL original en el image_url, así que además del match
 * exacto se intenta por nombre de archivo y, como último recurso, el ÚNICO
 * adjunto de imagen de la conversación. Nunca inventa: sin adjunto real → null. */
function resolveAttachment(
  rawUrl: string,
  attachmentsByUrl: Map<string, CopilotAttachment>,
): CopilotAttachment | null {
  const url = rawUrl.trim();
  const exact = attachmentsByUrl.get(url);
  if (exact) return exact;
  const all = [...attachmentsByUrl.values()];
  if (url && !url.startsWith("data:")) {
    const base = url.split("?")[0].split("/").pop() ?? "";
    const byName = all.filter(
      (a) =>
        (base && (a.url.split("?")[0].endsWith(`/${base}`) || a.storagePath.endsWith(base) || a.originalName === base)) ||
        a.url.endsWith(url),
    );
    if (byName.length === 1) return byName[0];
  }
  const images = all.filter((a) => a.type === "IMAGE");
  if (images.length === 1) return images[0];
  return null;
}

// ---------------------------------------------------------------------------
// Guía de campos por rubro (espejo compacto de los blueprints del panel)
// ---------------------------------------------------------------------------
const COMMON_FIELDS =
  "Campos comunes de `data`: name*, price* (texto, ej. '12' o '12.50'), shortDescription (1 línea vendedora), fullDescription, category, active (default true), aliases (string[] — sinónimos/abreviaturas con las que el cliente lo nombraría), benefits (string[]), includes (string[]), bonuses (string[]), faqs ([{question, answer}]), objections ([{question, answer}]), attributes (objeto clave→valor, ej. {\"Ingredientes\": \"pollo, papas\"}). " +
  "reminderConfig (recordatorios PROPIOS de este producto — si no se envía, hereda los generales del negocio): {abandonedCart?: {enabled, steps: [{delaySeconds (SEGUNDOS, ej. 3600=1h, 86400=24h), message, offerPrice? (OFERTA ESCALONADA: al enviarse ese paso, el agente ofrece/cobra/valida ese precio SOLO a ese cliente; usa {oferta} en el mensaje para mostrarlo)}]}, leftOnRead?: {enabled, steps: [...]}}; enviar null lo limpia (vuelve a heredar). " +
  "OFERTA CON VIGENCIA (global, todos los clientes): offerPrice (texto, ej. '49'), offerStartsAt/offerEndsAt (fecha-hora ISO, opcionales; sin fechas = activa hasta quitarla). Vigente => el agente presenta, cobra y valida ESE precio y el precio normal se muestra tachado como 'antes'. null limpia la oferta.";

function rubroGuide(vertical: string | undefined): string {
  switch (vertical) {
    case "RESTAURANT":
      return `Rubro RESTAURANTE (cada producto = un plato/bebida). ${COMMON_FIELDS} Además: category = SECCIÓN del menú (Entradas, Principales, Bebidas...); verticalData.modifierGroups = [{name, required (bool), options: [{label, priceDelta (número, 0 si no cambia el precio)}]}] para tamaños/extras (ej. Tamaño* Personal:0/Familiar:8); attributes con Ingredientes y "Tiempo de preparación".`;
    case "PHYSICAL_GOODS":
      return `Rubro COMERCIAL (productos físicos: ropa, ferretería, licorería...). ${COMMON_FIELDS} Además: stock (número, si controla inventario); variants = [{name, options: string[], sortOrder}] para Talla/Color (las opciones NO cambian el precio); physicalDelivery = {requiresAddress: true, deliveryCost?, deliveryTime?, pickupAvailable, deliveryAreas: string[]} (zonas de entrega — pregunta las zonas si va a crear el primero).`;
    case "SERVICE":
      return `Rubro SERVICIOS (cada producto = un servicio, con cita opcional). ${COMMON_FIELDS} Además: durationMin (minutos de la cita — con esto el agente agenda con horarios reales), slotCapacity (citas simultáneas, default 1), bookingLeadMinutes, bookingHorizonDays; deliveryMethod/support como texto libre si aplica.`;
    case "REAL_ESTATE":
      return `Rubro INMOBILIARIA (cada producto = un inmueble). ${COMMON_FIELDS} Además: verticalData con la ficha: {operation ('venta'|'alquiler'), propertyType, areaM2, bedrooms, bathrooms, parking, location, maintenance, antiquity}; durationMin para la duración de la visita (agenda).`;
    case "STREAMER":
      return `Rubro STREAMING (cada producto = una plataforma/cuenta). ${COMMON_FIELDS} Además: category = plataforma (Netflix, Disney...); verticalData.plans = [{label, price}] para modalidades (mensual/anual, pantallas) y verticalData.durationDays (duración de la suscripción en días); digitalDelivery = {instructions (mensaje de entrega con el acceso), assignmentMode, followupMessages: [{message, mediaUrl?}] (mensajes POST-VENTA que se envían inmediatamente tras entregar)}; RENOVACIÓN: reminderConfig.renewal = {enabled, daysBefore, message} (aviso al cliente N días antes del vencimiento).`;
    case "INFOPRODUCT":
      return `Rubro INFOPRODUCTOS (cursos, ebooks, accesos). ${COMMON_FIELDS} Además: digitalDelivery = {instructions* (mensaje de entrega que incluye el link de acceso), link, followupMessages: [{message, mediaUrl?}] (mensajes POST-VENTA que se envían inmediatamente tras entregar: agradecimiento, bonus, instrucciones extra)}; benefits/faqs/objections completos son CLAVE para que el agente venda bien.`;
    default:
      return `Rubro OTRO/general. ${COMMON_FIELDS} productType puede ser 'DIGITAL' o 'PHYSICAL'; si es físico agrega physicalDelivery.`;
  }
}

// ---------------------------------------------------------------------------
// data del modelo (simple/parcial) → ProductPayload de products.service
// ---------------------------------------------------------------------------
type LooseData = Record<string, unknown>;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "producto";
}

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asStrList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim()) : undefined;
const asOrdered = (v: unknown): Array<{ value: string; sortOrder: number }> | undefined =>
  Array.isArray(v)
    ? v.map((x, i) => ({ value: String((x as { value?: unknown })?.value ?? x), sortOrder: i })).filter((x) => x.value.trim())
    : undefined;
const asQa = (v: unknown): Array<{ question: string; answer: string; sortOrder: number }> | undefined =>
  Array.isArray(v)
    ? v
        .map((x, i) => ({
          question: String((x as { question?: unknown })?.question ?? "").trim(),
          answer: String((x as { answer?: unknown })?.answer ?? "").trim(),
          sortOrder: i,
        }))
        .filter((x) => x.question && x.answer)
    : undefined;

type AdminProduct = Awaited<ReturnType<typeof getProduct>>;

// --- Merge ADITIVO (default de actualizar_producto): agregar sin borrar ------
const norm = (s: string) => s.trim().toLowerCase();

/** Unión de listas de strings sin duplicados (case-insensitive), conservando el orden existente. */
function mergeStrList(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map(norm));
  return [...existing, ...incoming.filter((v) => v.trim() && !seen.has(norm(v)))];
}

/** Merge de arrays de objetos por clave (name/label): mismo nombre reemplaza, el resto se conserva, nuevos al final. */
function mergeNamed(cur: unknown, inc: unknown, key: string): Record<string, unknown>[] {
  const curArr = Array.isArray(cur) ? (cur as Record<string, unknown>[]) : [];
  const incArr = Array.isArray(inc) ? (inc as Record<string, unknown>[]) : [];
  const nameOf = (x: Record<string, unknown>) => norm(String(x?.[key] ?? ""));
  const byName = new Map(incArr.map((x) => [nameOf(x), x]));
  const merged = curArr.map((x) => byName.get(nameOf(x)) ?? x);
  const curNames = new Set(curArr.map(nameOf));
  merged.push(...incArr.filter((x) => !curNames.has(nameOf(x))));
  return merged;
}

/**
 * Construye el ProductPayload COMPLETO fusionando la data parcial del modelo
 * sobre el producto existente (o defaults si es creación). Solo se reemplazan
 * las claves presentes en `data` — updateProduct reescribe relaciones, así que
 * el merge server-side evita que el modelo borre FAQs/variants por accidente.
 *
 * Con `replace=false` (default de actualizar_producto) las LISTAS y OBJETOS
 * enviados se FUSIONAN con lo existente (el modelo suele mandar solo lo nuevo
 * cuando el usuario pide "agrégale X") y `null` se ignora. Con `replace=true`
 * lo enviado es la versión FINAL (así se quitan elementos) y `null` limpia.
 */
function buildPayload(data: LooseData, existing: AdminProduct | null, replace = false) {
  const e = existing;
  const additive = !replace && !!e;
  const name = asStr(data.name) ?? e?.name ?? "";

  const objField = <T extends Record<string, unknown>>(incoming: unknown, cur: T | null): T | null => {
    if (incoming === undefined) return cur;
    if (incoming === null) return additive ? cur : null;
    return additive && cur ? ({ ...cur, ...(incoming as T) } as T) : (incoming as T);
  };
  const orderedField = (incoming: ReturnType<typeof asOrdered>, cur: string[]) => {
    const curOrdered = cur.map((v, i) => ({ value: v, sortOrder: i }));
    if (incoming === undefined) return curOrdered;
    if (!additive) return incoming;
    const seen = new Set(cur.map(norm));
    return [...curOrdered, ...incoming.filter((x) => !seen.has(norm(x.value)))].map((x, i) => ({
      value: x.value,
      sortOrder: i,
    }));
  };
  const qaField = (
    incoming: ReturnType<typeof asQa>,
    cur: Array<{ question: string; answer: string; sortOrder: number }>,
  ) => {
    if (incoming === undefined) return cur;
    if (!additive) return incoming;
    const merged = cur.map((x) => incoming.find((n) => norm(n.question) === norm(x.question)) ?? x);
    const curQ = new Set(cur.map((x) => norm(x.question)));
    merged.push(...incoming.filter((n) => !curQ.has(norm(n.question))));
    return merged.map((x, i) => ({ question: x.question, answer: x.answer, sortOrder: i }));
  };

  return {
    slug: e?.slug ?? slugify(name),
    active: typeof data.active === "boolean" ? data.active : (e?.active ?? true),
    showInCatalog: typeof data.showInCatalog === "boolean" ? data.showInCatalog : (e?.showInCatalog ?? true),
    pauseHumanAfterSale: e?.pauseHumanAfterSale ?? false,
    productType: (asStr(data.productType) as "DIGITAL" | "PHYSICAL" | undefined) ?? e?.productType,
    name,
    price: asStr(data.price) ?? e?.price ?? "",
    regularPrice: data.regularPrice !== undefined ? asStr(data.regularPrice) ?? null : (e?.regularPrice ?? null),
    // Oferta con vigencia (escalares: null limpia la oferta).
    offerPrice: data.offerPrice !== undefined ? asStr(data.offerPrice) ?? null : (e?.offerPrice ?? null),
    offerStartsAt:
      data.offerStartsAt !== undefined
        ? data.offerStartsAt
          ? new Date(String(data.offerStartsAt))
          : null
        : (e?.offerStartsAt ?? null),
    offerEndsAt:
      data.offerEndsAt !== undefined
        ? data.offerEndsAt
          ? new Date(String(data.offerEndsAt))
          : null
        : (e?.offerEndsAt ?? null),
    stock: data.stock !== undefined ? (Number.isFinite(Number(data.stock)) ? Number(data.stock) : null) : (e?.stock ?? null),
    durationMin: data.durationMin !== undefined ? Number(data.durationMin) || null : (e?.durationMin ?? null),
    slotCapacity: data.slotCapacity !== undefined ? Number(data.slotCapacity) || null : (e?.slotCapacity ?? null),
    bookingLeadMinutes:
      data.bookingLeadMinutes !== undefined ? Number(data.bookingLeadMinutes) || null : (e?.bookingLeadMinutes ?? null),
    bookingHorizonDays:
      data.bookingHorizonDays !== undefined ? Number(data.bookingHorizonDays) || null : (e?.bookingHorizonDays ?? null),
    shortDescription: asStr(data.shortDescription) ?? e?.shortDescription ?? "",
    fullDescription: asStr(data.fullDescription) ?? e?.fullDescription ?? "",
    presentationMessage:
      data.presentationMessage !== undefined ? asStr(data.presentationMessage) ?? null : (e?.presentationMessage ?? null),
    presentationMessageMediaUrl: e?.presentationMessageMediaUrl ?? "",
    presentationMessageMediaType: e?.presentationMessageMediaType ?? "",
    presentationFollowups: (e?.presentationFollowups ?? []) as { message?: string; mediaUrl?: string; mediaType?: string }[],
    deliveryMethod: data.deliveryMethod !== undefined ? asStr(data.deliveryMethod) ?? null : (e?.deliveryMethod ?? null),
    support: data.support !== undefined ? asStr(data.support) ?? null : (e?.support ?? null),
    attributes: objField(data.attributes, (e?.attributes ?? null) as Record<string, string> | null),
    category: data.category !== undefined ? asStr(data.category) ?? null : (e?.category ?? null),
    verticalData: (() => {
      const cur = (e?.verticalData ?? null) as Record<string, unknown> | null;
      const merged = objField(data.verticalData, cur);
      // Dentro del verticalData, los arrays con identidad propia se fusionan por
      // nombre (modifierGroups del rubro restaurante, plans de streaming).
      if (additive && merged && cur && data.verticalData && typeof data.verticalData === "object") {
        const inc = data.verticalData as Record<string, unknown>;
        if (inc.modifierGroups !== undefined) merged.modifierGroups = mergeNamed(cur.modifierGroups, inc.modifierGroups, "name");
        if (inc.plans !== undefined) merged.plans = mergeNamed(cur.plans, inc.plans, "label");
      }
      return merged;
    })(),
    reminderConfig: objField(data.reminderConfig, (e?.reminderConfig ?? null) as Record<string, unknown> | null),
    sortOrder: e?.sortOrder,
    aliases: (() => {
      const inc = asStrList(data.aliases);
      const cur = e?.aliases ?? [];
      if (inc === undefined) return cur;
      return additive ? mergeStrList(cur, inc) : inc;
    })(),
    benefits: orderedField(asOrdered(data.benefits), e?.benefits ?? []),
    includes: orderedField(asOrdered(data.includes), e?.includes ?? []),
    bonuses: orderedField(asOrdered(data.bonuses), e?.bonuses ?? []),
    faqs: qaField(asQa(data.faqs), e?.faqs ?? []),
    objections: qaField(asQa(data.objections), e?.objections ?? []),
    files: (e?.files ?? []) as never[],
    digitalDelivery: objField(
      data.digitalDelivery,
      (e?.digitalDelivery ?? null) as Record<string, unknown> | null,
    ) as never,
    physicalDelivery: objField(
      data.physicalDelivery,
      (e?.physicalDelivery ?? null) as Record<string, unknown> | null,
    ) as never,
    variants: (() => {
      const curV = (e?.variants ?? []).map((v: { name: string; options: string[]; sortOrder: number }) => ({
        name: v.name,
        options: v.options,
        sortOrder: v.sortOrder,
      }));
      if (!Array.isArray(data.variants)) return curV;
      const incV = (data.variants as Array<{ name?: unknown; options?: unknown }>)
        .map((v, i) => ({ name: String(v?.name ?? "").trim(), options: asStrList(v?.options) ?? [], sortOrder: i }))
        .filter((v) => v.name);
      if (!additive) return incV;
      const merged = curV.map((cv) => {
        const nv = incV.find((x) => norm(x.name) === norm(cv.name));
        return nv ? { ...cv, options: mergeStrList(cv.options, nv.options) } : cv;
      });
      const curNames = new Set(curV.map((v) => norm(v.name)));
      merged.push(...incV.filter((nv) => !curNames.has(norm(nv.name))));
      return merged.map((v, i) => ({ ...v, sortOrder: i }));
    })(),
  };
}

function zodErrorsText(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues.map((i) => `${i.path.map(String).join(".") || "raíz"}: ${i.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// Ejecución de tools
// ---------------------------------------------------------------------------
/** Resuelve una categoría de respuestas rápidas por NOMBRE (case-insensitive), creándola si no existe. */
async function resolveQuickReplyCategory(companyId: string, name?: string): Promise<string | undefined> {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  const categories = await listCategories(companyId);
  const found = categories.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (found) return found.id;
  const created = await createCategory(companyId, trimmed);
  return created.id;
}

async function runCopilotTool(
  companyId: string,
  name: string,
  args: LooseData,
  attachmentsByUrl: Map<string, CopilotAttachment>,
): Promise<{ result: string; wrote: boolean }> {
  switch (name) {
    case "adjuntar_foto_producto": {
      const url = String(args.url ?? "").trim();
      const meta = resolveAttachment(url, attachmentsByUrl);
      if (!meta) {
        const disponibles = [...attachmentsByUrl.keys()];
        return {
          result: JSON.stringify({
            ok: false,
            error: disponibles.length
              ? `URL no reconocida. Adjuntos disponibles en esta conversación: ${disponibles.join(" | ")}. Reintenta con una de esas URLs EXACTAS (no pidas re-adjuntar).`
              : "no hay adjuntos en esta conversación; pide al usuario que envíe la imagen",
          }),
          wrote: false,
        };
      }
      const productId = String(args.productId ?? "");
      const existing = await getProduct(companyId, productId);
      const principal = args.principal === true;
      const currentFiles = (existing.files ?? []) as Array<{ sortOrder: number } & Record<string, unknown>>;
      if (currentFiles.some((f) => f.url === meta.url)) {
        return { result: JSON.stringify({ ok: false, error: "esa imagen ya está adjunta a este producto" }), wrote: false };
      }
      const newFile = {
        type: meta.type,
        url: meta.url,
        storagePath: meta.storagePath,
        originalName: meta.originalName,
        extension: meta.extension,
        mimeType: meta.mimeType,
        size: meta.size,
        description: asStr(args.description)?.trim() || `Foto de ${existing.name}`,
        sortOrder: principal ? 0 : currentFiles.length,
      };
      const payload = buildPayload({}, existing);
      payload.files = (principal
        ? [newFile, ...currentFiles.map((f) => ({ ...f, sortOrder: (f.sortOrder ?? 0) + 1 }))]
        : [...currentFiles, newFile]) as never[];
      const parsed = productBodySchema.safeParse(payload);
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      await updateProduct(companyId, productId, parsed.data as Parameters<typeof updateProduct>[2]);
      return {
        result: JSON.stringify({
          ok: true,
          product: existing.name,
          principal,
          nota: principal ? "Imagen adjuntada como foto PRINCIPAL del producto." : "Imagen adjuntada al producto.",
        }),
        wrote: true,
      };
    }

    case "listar_productos": {
      const products = await prisma.product.findMany({
        where: { companyId },
        select: { id: true, name: true, price: true, category: true, active: true, stock: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
        take: 100,
      });
      return { result: JSON.stringify({ count: products.length, products }), wrote: false };
    }

    case "ver_producto": {
      const product = await getProduct(companyId, String(args.productId ?? ""));
      return { result: JSON.stringify(product), wrote: false };
    }

    case "crear_producto": {
      const payload = buildPayload((args.data ?? {}) as LooseData, null);
      const parsed = productBodySchema.safeParse(payload);
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      try {
        const created = await createProduct(companyId, parsed.data as Parameters<typeof createProduct>[1]);
        return {
          result: JSON.stringify({ ok: true, productId: created.id, name: created.name, nota: "Producto creado." }),
          wrote: true,
        };
      } catch (err) {
        // Slug duplicado u otro conflicto: reintentar con sufijo.
        const message = err instanceof Error ? err.message : "no se pudo crear";
        if (/unique|duplicad|P2002/i.test(message)) {
          parsed.data.slug = `${parsed.data.slug}-${Math.random().toString(36).slice(2, 6)}`;
          const created = await createProduct(companyId, parsed.data as Parameters<typeof createProduct>[1]);
          return {
            result: JSON.stringify({ ok: true, productId: created.id, name: created.name, nota: "Producto creado." }),
            wrote: true,
          };
        }
        return { result: JSON.stringify({ ok: false, error: message }), wrote: false };
      }
    }

    case "actualizar_producto": {
      const productId = String(args.productId ?? "");
      const existing = await getProduct(companyId, productId);
      const payload = buildPayload((args.data ?? {}) as LooseData, existing, args.reemplazar === true);
      const parsed = productBodySchema.safeParse(payload);
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      const updated = await updateProduct(companyId, productId, parsed.data as Parameters<typeof updateProduct>[2]);
      return {
        result: JSON.stringify({ ok: true, productId: updated.id, name: updated.name, nota: "Producto actualizado (lo no enviado se conservó)." }),
        wrote: true,
      };
    }

    case "eliminar_producto": {
      const productId = String(args.productId ?? "");
      const existing = await getProduct(companyId, productId);
      await deleteProduct(companyId, productId);
      return { result: JSON.stringify({ ok: true, deleted: existing.name }), wrote: true };
    }

    case "ver_configuracion": {
      const [company, agent, payment] = await Promise.all([
        prisma.company.findUnique({
          where: { id: companyId },
          select: {
            name: true,
            vertical: true,
            timezone: true,
            botMode: true,
            deliveryConfig: true,
            businessHours: true,
            firmaEnabled: true,
            firmaText: true,
            _count: { select: { products: true } },
          },
        }),
        prisma.agentConfig.findUnique({
          where: { companyId },
          select: {
            basePrompt: true,
            salesStyle: true,
            rules: true,
            negotiationHandoff: true,
            catalogMode: true,
            keywordMode: true,
            trackStock: true,
            catalogMediaMode: true,
          },
        }),
        prisma.paymentConfig.findUnique({
          where: { companyId },
          include: { methods: { orderBy: { sortOrder: "asc" } } },
        }),
      ]);
      return {
        result: JSON.stringify({
          empresa: company ? { ...company, productCount: company._count.products, _count: undefined } : null,
          agente: agent,
          pagos: payment
            ? {
                enabled: payment.enabled,
                paymentMode: payment.paymentMode,
                notificationPhone: payment.notificationPhone,
                methods: payment.methods.map((m) => ({ method: m.method, number: m.number, holder: m.holder })),
              }
            : null,
        }),
        wrote: false,
      };
    }

    case "configurar_empresa": {
      const data = (args.data ?? {}) as LooseData;
      const current = await prisma.company.findUnique({ where: { id: companyId } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "empresa no encontrada" }), wrote: false };
      const updated = await updateBusinessProfile(companyId, {
        name: asStr(data.name) ?? current.name,
        slug: current.slug,
        adminPhone: asStr(data.adminPhone) ?? current.adminPhone,
        vertical: (asStr(data.vertical) as typeof current.vertical | undefined) ?? current.vertical,
        timezone: asStr(data.timezone) ?? current.timezone,
        botMode: (asStr(data.botMode) as "AI" | "FLOW" | undefined) ?? (current.botMode as "AI" | "FLOW"),
        isActive: current.isActive,
        // undefined = no tocar (el service ya respeta esa semántica).
        deliveryConfig: data.deliveryConfig !== undefined ? (data.deliveryConfig as DeliveryConfigInput | null) : undefined,
        businessHours:
          data.businessHours !== undefined
            ? (data.businessHours as Array<{ day: number; from: string; to: string }> | null)
            : undefined,
        firmaEnabled: typeof data.firmaEnabled === "boolean" ? data.firmaEnabled : current.firmaEnabled,
        firmaText: data.firmaText !== undefined ? asStr(data.firmaText) ?? null : current.firmaText,
        messageGapEnabled: current.messageGapEnabled,
        messageGapSeconds: current.messageGapSeconds,
      });
      return {
        result: JSON.stringify({ ok: true, empresa: { name: updated.name, vertical: updated.vertical, timezone: updated.timezone }, nota: "Empresa actualizada (lo no enviado se conservó)." }),
        wrote: true,
      };
    }

    case "configurar_agente": {
      const data = (args.data ?? {}) as LooseData;
      const current = await prisma.agentConfig.findUnique({ where: { companyId } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "config del agente no encontrada" }), wrote: false };
      const rulesIncoming = Array.isArray(data.rules) ? (data.rules as unknown[]).map(String).filter((r) => r.trim()) : undefined;
      const currentRules = (current.rules as string[]) ?? [];
      const rules =
        rulesIncoming === undefined
          ? currentRules
          : args.reemplazarReglas === true
            ? rulesIncoming
            : mergeStrList(currentRules, rulesIncoming);
      await upsertAgentConfig(companyId, {
        // Proveedor/modelo/key NO se gestionan por chat: se conservan tal cual
        // (sin aiProvider el upsert lo resetearía a OPENAI y fallaría el guard).
        aiProvider: current.aiProvider,
        openaiModel: current.openaiModel,
        temperature: Number(current.temperature),
        basePrompt: asStr(data.basePrompt) ?? current.basePrompt,
        salesStyle: asStr(data.salesStyle) ?? current.salesStyle,
        rules,
        negotiationHandoff:
          typeof data.negotiationHandoff === "boolean" ? data.negotiationHandoff : (current.negotiationHandoff ?? false),
        catalogMode: asStr(data.catalogMode) ?? (current.catalogMode as string),
        keywordMode: asStr(data.keywordMode) ?? (current.keywordMode as string),
        trackStock: typeof data.trackStock === "boolean" ? data.trackStock : (current.trackStock ?? true),
        catalogMediaMode: asStr(data.catalogMediaMode) ?? (current.catalogMediaMode as string),
      });
      return {
        result: JSON.stringify({ ok: true, nota: "Agente IA actualizado (la API key y el modelo no se tocaron)." }),
        wrote: true,
      };
    }

    case "configurar_pagos": {
      const data = (args.data ?? {}) as LooseData;
      const current = await prisma.paymentConfig.findUnique({
        where: { companyId },
        include: { methods: { orderBy: { sortOrder: "asc" } } },
      });
      const mode = asStr(data.paymentMode);
      if (mode && !["BEFORE_DELIVERY", "CASH_ON_DELIVERY", "MANUAL", "CUSTOMER_CHOICE"].includes(mode)) {
        return { result: JSON.stringify({ ok: false, error: "paymentMode inválido" }), wrote: false };
      }
      const methods = Array.isArray(data.methods)
        ? (data.methods as Array<{ method?: unknown; number?: unknown; holder?: unknown }>)
            .map((m, i) => ({
              method: String(m?.method ?? "").trim(),
              number: String(m?.number ?? "").trim(),
              holder: String(m?.holder ?? "").trim(),
              sortOrder: i,
            }))
            .filter((m) => m.method && m.number && m.holder)
        : undefined;
      const notificationPhone = asStr(data.notificationPhone) ?? current?.notificationPhone ?? "";
      const curMethods = (current?.methods ?? []).map((m) => ({ method: m.method, number: m.number, holder: m.holder, sortOrder: m.sortOrder }));
      // Aditivo por defecto: los métodos enviados se fusionan por método+número
      // (coincide → actualiza titular; nuevo → se agrega). reemplazarMetodos=true
      // toma la lista enviada como la FINAL (así se quita un método).
      const finalMethods = (() => {
        if (methods === undefined) return curMethods;
        if (args.reemplazarMetodos === true || !curMethods.length) return methods;
        const keyOf = (m: { method: string; number: string }) => `${norm(m.method)}|${m.number.replace(/\s/g, "")}`;
        const byKey = new Map(methods.map((m) => [keyOf(m), m]));
        const merged = curMethods.map((m) => byKey.get(keyOf(m)) ?? m);
        const curKeys = new Set(curMethods.map(keyOf));
        merged.push(...methods.filter((m) => !curKeys.has(keyOf(m))));
        return merged.map((m, i) => ({ ...m, sortOrder: i }));
      })();
      if (!finalMethods.length) {
        return {
          result: JSON.stringify({ ok: false, error: "se necesita al menos un método de pago (method/number/holder) para guardar" }),
          wrote: false,
        };
      }
      if (!notificationPhone) {
        return {
          result: JSON.stringify({ ok: false, error: "falta notificationPhone (WhatsApp donde avisar los pagos) — pídeselo al usuario" }),
          wrote: false,
        };
      }
      await upsertPaymentConfig(companyId, {
        enabled: typeof data.enabled === "boolean" ? data.enabled : (current?.enabled ?? true),
        notificationPhone,
        methods: finalMethods,
        paymentMode: (mode as "BEFORE_DELIVERY" | "CASH_ON_DELIVERY" | "MANUAL" | "CUSTOMER_CHOICE" | undefined) ??
          (current?.paymentMode ?? "BEFORE_DELIVERY"),
      });
      return { result: JSON.stringify({ ok: true, nota: "Pagos actualizados (lo no enviado se conservó)." }), wrote: true };
    }

    case "ver_crm": {
      const [crms, tags] = await Promise.all([
        prisma.crm.findMany({
          where: { companyId },
          select: {
            id: true,
            name: true,
            description: true,
            columns: { select: { id: true, name: true }, orderBy: { sortOrder: "asc" } },
          },
          orderBy: { sortOrder: "asc" },
        }),
        prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true, color: true } }),
      ]);
      return { result: JSON.stringify({ crms, tags }), wrote: false };
    }

    case "crear_crm": {
      const cols = asStrList(args.columns) ?? [];
      if (!asStr(args.name)?.trim()) return { result: JSON.stringify({ ok: false, error: "falta el nombre del tablero" }), wrote: false };
      const crm = await createCrm(companyId, {
        name: String(args.name).trim(),
        description: asStr(args.description) ?? null,
        color: asStr(args.color) ?? "#6366f1",
      });
      for (const colName of cols) {
        await createColumn(companyId, crm.id, { name: colName });
      }
      return { result: JSON.stringify({ ok: true, crmId: crm.id, name: crm.name, columns: cols }), wrote: true };
    }

    case "crear_columna": {
      const column = await createColumn(companyId, String(args.crmId ?? ""), {
        name: String(args.name ?? "").trim(),
        color: asStr(args.color) ?? null,
      });
      return { result: JSON.stringify({ ok: true, columnId: column.id, name: column.name }), wrote: true };
    }

    case "crear_etiqueta": {
      const tag = await createTag(companyId, {
        name: String(args.name ?? "").trim(),
        color: asStr(args.color) ?? "#6366f1",
      });
      return { result: JSON.stringify({ ok: true, tagId: tag.id, name: tag.name }), wrote: true };
    }

    case "actualizar_crm": {
      const crmId = String(args.crmId ?? "");
      const current = await prisma.crm.findFirst({ where: { id: crmId, companyId } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "tablero no encontrado" }), wrote: false };
      const crm = await updateCrm(companyId, crmId, {
        name: asStr(args.name) ?? current.name,
        description: args.description !== undefined ? asStr(args.description) ?? null : current.description,
        color: asStr(args.color) ?? current.color,
      });
      return { result: JSON.stringify({ ok: true, crm: { id: crm.id, name: crm.name } }), wrote: true };
    }

    case "eliminar_crm": {
      const crmId = String(args.crmId ?? "");
      const current = await prisma.crm.findFirst({ where: { id: crmId, companyId }, select: { name: true } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "tablero no encontrado" }), wrote: false };
      await deleteCrm(companyId, crmId);
      return { result: JSON.stringify({ ok: true, deleted: current.name }), wrote: true };
    }

    case "actualizar_columna": {
      const crmId = String(args.crmId ?? "");
      const columnId = String(args.columnId ?? "");
      const current = await prisma.crmColumn.findFirst({ where: { id: columnId, crmId, companyId } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "columna no encontrada" }), wrote: false };
      const column = await updateColumn(companyId, crmId, columnId, {
        name: asStr(args.name) ?? current.name,
        color: args.color !== undefined ? asStr(args.color) ?? null : current.color,
      });
      return { result: JSON.stringify({ ok: true, column: { id: column.id, name: column.name } }), wrote: true };
    }

    case "eliminar_columna": {
      const crmId = String(args.crmId ?? "");
      const columnId = String(args.columnId ?? "");
      const current = await prisma.crmColumn.findFirst({ where: { id: columnId, crmId, companyId }, select: { name: true } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "columna no encontrada" }), wrote: false };
      await deleteColumn(companyId, crmId, columnId);
      return {
        result: JSON.stringify({ ok: true, deleted: current.name, nota: "Los clientes de esa columna volvieron al Inbox." }),
        wrote: true,
      };
    }

    case "reordenar_columnas": {
      const crmId = String(args.crmId ?? "");
      const columnIds = asStrList(args.columnIds) ?? [];
      if (!columnIds.length) return { result: JSON.stringify({ ok: false, error: "faltan los columnIds en orden" }), wrote: false };
      await reorderColumns(companyId, crmId, columnIds);
      return { result: JSON.stringify({ ok: true, orden: columnIds }), wrote: true };
    }

    case "actualizar_etiqueta": {
      const tagId = String(args.tagId ?? "");
      const current = await prisma.customerTag.findFirst({ where: { id: tagId, companyId } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "etiqueta no encontrada" }), wrote: false };
      const tag = await updateTag(companyId, tagId, {
        name: asStr(args.name) ?? current.name,
        color: asStr(args.color) ?? current.color,
      });
      return { result: JSON.stringify({ ok: true, tag: { id: tag.id, name: tag.name, color: tag.color } }), wrote: true };
    }

    case "eliminar_etiqueta": {
      const tagId = String(args.tagId ?? "");
      const current = await prisma.customerTag.findFirst({ where: { id: tagId, companyId }, select: { name: true } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "etiqueta no encontrada" }), wrote: false };
      await deleteTag(companyId, tagId);
      return {
        result: JSON.stringify({ ok: true, deleted: current.name, nota: "La etiqueta se quitó de todos los clientes que la tenían." }),
        wrote: true,
      };
    }

    case "ver_respuestas_rapidas": {
      const [replies, categories] = await Promise.all([listQuickReplies(companyId), listCategories(companyId)]);
      return {
        result: JSON.stringify({
          respuestas: replies.map((r) => ({
            id: r.id,
            title: r.title,
            command: r.command,
            categoryId: r.categoryId,
            mensajes: Array.isArray(r.messages) ? r.messages.length : 0,
          })),
          categorias: categories,
        }),
        wrote: false,
      };
    }

    case "crear_respuesta_rapida": {
      const categoryId = await resolveQuickReplyCategory(companyId, asStr(args.category));
      const parsed = upsertQuickReplySchema.safeParse({
        title: String(args.title ?? "").trim(),
        command: asStr(args.command) ?? null,
        ...(categoryId ? { categoryId } : {}),
        messages: Array.isArray(args.messages) ? args.messages : [],
      });
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      try {
        const created = await createQuickReply(companyId, parsed.data);
        return { result: JSON.stringify({ ok: true, quickReplyId: created.id, title: created.title, command: created.command }), wrote: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "no se pudo crear";
        return { result: JSON.stringify({ ok: false, error: message }), wrote: false };
      }
    }

    case "actualizar_respuesta_rapida": {
      const quickReplyId = String(args.quickReplyId ?? "");
      const current = await prisma.quickReply.findFirst({ where: { id: quickReplyId, companyId } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "respuesta rápida no encontrada" }), wrote: false };
      const data = (args.data ?? {}) as LooseData;
      const categoryId =
        data.category !== undefined ? await resolveQuickReplyCategory(companyId, asStr(data.category)) : current.categoryId;
      const parsed = upsertQuickReplySchema.safeParse({
        title: asStr(data.title) ?? current.title,
        command: data.command !== undefined ? asStr(data.command) ?? null : current.command,
        ...(categoryId ? { categoryId } : {}),
        // Aditivo por defecto: los mensajes nuevos se AGREGAN al final de la
        // secuencia; reemplazarMensajes=true la reescribe completa.
        messages: Array.isArray(data.messages)
          ? args.reemplazarMensajes === true
            ? data.messages
            : [...((current.messages as unknown[]) ?? []), ...data.messages]
          : (current.messages as unknown[]),
        ...(current.actions ? { actions: current.actions } : {}),
      });
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      try {
        const updated = await updateQuickReply(companyId, quickReplyId, parsed.data);
        return { result: JSON.stringify({ ok: true, title: updated.title, command: updated.command, nota: "Respuesta rápida actualizada (lo no enviado se conservó)." }), wrote: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "no se pudo actualizar";
        return { result: JSON.stringify({ ok: false, error: message }), wrote: false };
      }
    }

    case "eliminar_respuesta_rapida": {
      const quickReplyId = String(args.quickReplyId ?? "");
      const current = await prisma.quickReply.findFirst({ where: { id: quickReplyId, companyId }, select: { title: true } });
      if (!current) return { result: JSON.stringify({ ok: false, error: "respuesta rápida no encontrada" }), wrote: false };
      await deleteQuickReply(companyId, quickReplyId);
      return { result: JSON.stringify({ ok: true, deleted: current.title }), wrote: true };
    }

    case "gestionar_cliente_crm": {
      const phoneDigits = String(args.phone ?? "").replace(/\D/g, "");
      if (!phoneDigits) return { result: JSON.stringify({ ok: false, error: "falta el teléfono del cliente" }), wrote: false };
      const customer = await prisma.customer.findFirst({
        where: { companyId, phone: { contains: phoneDigits } },
        select: { id: true, name: true, phone: true },
      });
      if (!customer) {
        return { result: JSON.stringify({ ok: false, error: `no encontré un cliente con el teléfono ${phoneDigits}` }), wrote: false };
      }
      const addNames = asStrList(args.addTagNames) ?? [];
      const removeNames = asStrList(args.removeTagNames) ?? [];
      const tags = addNames.length || removeNames.length
        ? await prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } })
        : [];
      const idsByName = (names: string[]) =>
        names
          .map((n) => tags.find((t) => t.name.toLowerCase() === n.trim().toLowerCase())?.id)
          .filter((id): id is string => Boolean(id));
      const tagIds = idsByName(addNames);
      const removeTagIds = idsByName(removeNames);
      const missing = [...addNames, ...removeNames].filter(
        (n) => !tags.some((t) => t.name.toLowerCase() === n.trim().toLowerCase()),
      );
      await applyCrmAndTagActions(companyId, customer.id, {
        tagIds: tagIds.length ? tagIds : null,
        removeTagIds: removeTagIds.length ? removeTagIds : null,
        crmId: asStr(args.crmId) ?? null,
        crmColumnId: asStr(args.columnId) ?? null,
      });
      return {
        result: JSON.stringify({
          ok: true,
          customer: customer.name ?? customer.phone,
          ...(missing.length ? { aviso: `Etiquetas inexistentes ignoradas: ${missing.join(", ")} (créalas con crear_etiqueta si hacen falta)` } : {}),
        }),
        wrote: true,
      };
    }

    case "configurar_chat_web": {
      const data = (args.data ?? {}) as LooseData;
      // Dominios: unión con los existentes por defecto; reemplazarDominios=true
      // toma la lista enviada como la final (así se quita un dominio).
      let allowedOrigins: string[] | undefined;
      if (data.allowedOrigins !== undefined) {
        const inc = asStrList(data.allowedOrigins) ?? [];
        if (args.reemplazarDominios === true) {
          allowedOrigins = inc;
        } else {
          const currentWc = await prisma.webchatConfig.findUnique({ where: { companyId }, select: { allowedOrigins: true } });
          const cur = Array.isArray(currentWc?.allowedOrigins) ? (currentWc.allowedOrigins as string[]) : [];
          allowedOrigins = mergeStrList(cur, inc);
        }
      }
      const updated = await updateWebchatConfig(companyId, {
        ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}),
        ...(data.welcomeMessage !== undefined ? { welcomeMessage: String(data.welcomeMessage ?? "") } : {}),
        ...(data.accentColor !== undefined ? { accentColor: String(data.accentColor ?? "") } : {}),
        ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
      });
      return {
        result: JSON.stringify({
          ok: true,
          chatWeb: { enabled: updated.enabled, welcomeMessage: updated.welcomeMessage, accentColor: updated.accentColor },
          nota: "Chat web actualizado (el token del widget no cambió).",
        }),
        wrote: true,
      };
    }

    case "configurar_recordatorios": {
      const data = (args.data ?? {}) as LooseData;
      const current = await prisma.agentConfig.findUnique({ where: { companyId }, select: { followupConfig: true } });
      const merged = {
        ...((current?.followupConfig ?? {}) as Record<string, unknown>),
        ...(data.abandonedCart !== undefined ? { abandonedCart: data.abandonedCart } : {}),
        ...(data.leftOnRead !== undefined ? { leftOnRead: data.leftOnRead } : {}),
        ...(data.quietHours !== undefined ? { quietHours: data.quietHours } : {}),
      };
      const parsed = followupConfigSchema.safeParse(merged);
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      await updateAgentReminders(companyId, (parsed.data ?? null) as Record<string, unknown> | null);
      return { result: JSON.stringify({ ok: true, nota: "Recordatorios actualizados (lo no enviado se conservó)." }), wrote: true };
    }

    case "ver_mi_plan": {
      const me = await getBillingMe(companyId);
      if (me.legacy || !me.plan) {
        return {
          result: JSON.stringify({
            ok: true,
            plan: "Acceso completo sin suscripción (cuenta legacy): todos los módulos disponibles, sin vencimiento.",
          }),
          wrote: false,
        };
      }
      return {
        result: JSON.stringify({
          ok: true,
          plan: {
            nombre: me.plan.name,
            precio: `S/ ${me.plan.pricePen}/mes (USD ${me.plan.priceUsd})`,
            estado: me.status,
            vence: me.expiresAt,
            leadsDelMes: { usados: me.leadUsage.used, limite: me.leadUsage.limit ?? "ilimitados" },
            modulosIncluidos: me.plan.modules,
            beneficios: me.plan.perks,
            creditosPen: me.wallet.balancePen,
          },
          nota: "Renovar, cambiar de plan, recargar créditos o canjear vales se hace en la página Mi plan (/mi-plan).",
        }),
        wrote: false,
      };
    }

    default:
      return { result: JSON.stringify({ ok: false, error: `herramienta desconocida: ${name}` }), wrote: false };
  }
}

// ---------------------------------------------------------------------------
// Guía curada del sistema: fuente oficial para dudas de uso del panel.
// Mantenerla fiel a la UI real (rutas, labels y pasos) — el copiloto tiene
// PROHIBIDO inventar pasos que no estén aquí.
// ---------------------------------------------------------------------------
const SYSTEM_GUIDE = [
  "=== GUÍA DEL SISTEMA FLOWAPP (fuente oficial — para dudas de uso responde SOLO con esto) ===",
  "FlowApp es un panel donde el dueño configura un agente de ventas IA que atiende su WhatsApp (y opcionalmente un chat web): responde clientes, vende el catálogo, toma pedidos/citas y valida pagos.",
  "",
  "CONEXIÓN DE WHATSAPP — página 'WhatsApp API' (/whatsapp). Hay DOS formas, el tenant elige una:",
  "1) SMS Tools (QR): vincula su número de WhatsApp NORMAL escaneando un QR, igual que WhatsApp Web. Pasos: entrar a WhatsApp API → tarjeta 'SMS Tools (QR)' → botón 'Vincular por QR' → en el celular: WhatsApp → Configuración → Dispositivos vinculados → Vincular un dispositivo → escanear. Queda conectado en minutos y puede seguir usando WhatsApp en su celular. Si se desconecta, hay 'Re-vincular' (nuevo QR).",
  "2) API oficial de Meta (sin QR): número dedicado conectado a la API de WhatsApp Business (Cloud API). En la misma página está el botón 'Abrir guía de conexión' con un wizard paso a paso (~15 min, se hace una vez): crear app en Meta for Developers (tipo Empresa, producto WhatsApp), copiar Phone Number ID y WABA ID, generar un token permanente de Usuario del sistema, y 'Guardar y validar'. OJO: ese número queda dedicado a la plataforma (no se puede usar a la vez en la app normal de WhatsApp). Meta regala un número de prueba para empezar.",
  "Recomendación práctica: SMS Tools es lo más rápido para empezar; Meta es la vía oficial (más estable, requiere pasos técnicos).",
  "",
  "MAPA DEL PANEL (menú lateral):",
  "- Activación (/activacion): checklist de puesta en marcha con % de avance y botón de capacitación 1:1 por WhatsApp.",
  "- Dashboard (/dashboard): métricas del negocio.",
  "- Conversaciones (/conversaciones): chats en vivo; el asesor humano puede intervenir (el bot se pausa), usar respuestas rápidas con /comando y reactivar el bot.",
  "- CRM (/crm): tablero kanban de clientes con columnas y etiquetas (módulo CRM).",
  "- Campañas (/campanas): envíos masivos por WhatsApp (módulo Campañas).",
  "- Embudo (/embudo): embudo de ventas (módulo Embudo).",
  "- Comprobantes (/comprobantes): pagos/vouchers recibidos y su validación.",
  "- Pedidos (/pedidos): solo rubros restaurante y comercial. Reservas (/reservas) y Reservas online (/reservas-online): solo rubros servicios e inmobiliaria. Vencimientos (/vencimientos): solo rubro streaming.",
  "- Productos (/productos): el catálogo que vende el agente (esto también lo configuro YO por chat). Cada producto puede tener OFERTA con vigencia (precio de oferta + desde/hasta): vigente, el agente la presenta, cobra y valida ese precio y el normal sale tachado como 'antes'. Además hay OFERTAS ESCALONADAS en los recordatorios: cada paso puede llevar su precio (si el cliente no compra, el recordatorio 1 ofrece un precio y el 2 uno mejor — solo para ese cliente).",
  "- Empresa (/empresa): nombre, rubro, zona horaria, horario de atención, delivery, firma.",
  "- Mi plan (/mi-plan): plan actual, leads del mes, renovar/cambiar plan pagando con Mercado Pago (1 o 12 meses), recargar créditos y canjear vales.",
  "- Agente IA (/agente): prompt del agente, estilo, comportamiento comercial, PROVEEDOR DE IA (OpenAI, Anthropic Claude o Google Gemini), modelo y API keys (necesarias para el agente y para este copiloto). Cambiar de proveedor pide ingresar la API key de ese proveedor. Las notas de voz de WhatsApp se transcriben con OpenAI (Whisper): si el proveedor es Claude/Gemini hay un campo aparte y opcional para una key de OpenAI solo para audios — sin ella los audios no se transcriben.",
  "- Flujos de chatbot (/flujos): flujos guiados visuales con su propio copiloto IA (módulo Flujos).",
  "- Recordatorios (/recordatorios): mensajes programados (carrito abandonado, dejado en visto, recordatorios de cita, renovaciones).",
  "- Pagos (/pagos): métodos de pago manuales que el bot ofrece (Yape/Plin/cuentas), modo de cobro y WhatsApp de avisos.",
  "- WhatsApp API (/whatsapp): conexión del canal (ver arriba).",
  "- Chat Web (/chat-web): widget de chat con IA para la web del negocio — genera un snippet <script> con token para pegar en su página, con dominios permitidos, color y bienvenida (módulo Chat web).",
  "- Pruebas (/pruebas): simulador para chatear con el agente sin gastar WhatsApp real.",
  "- Integraciones (/integraciones): Mercado Pago (links de pago automáticos: se pega el Access Token APP_USR-… de mercadopago.com.pe/developers; módulo Mercado Pago) y ValidPay para Yape/Plin automático (secret + webhook; módulo Webhooks).",
  "- Centro de ayuda (/ayuda): manuales, videos y guías publicados por FlowApp.",
  "",
  "PLANES Y MÓDULOS: cada plan incluye módulos (Campañas masivas, CRM kanban, Flujos guiados, Embudo de ventas, Chat web, Mercado Pago, Webhooks) y un límite de leads/mes. Si una página no aparece en el menú del tenant es porque su plan no incluye ese módulo o su rubro no la usa. Los precios vigentes están en la sección PLANES de este prompt; el plan propio del negocio se consulta con ver_mi_plan.",
  "=== FIN DE LA GUÍA ===",
].join("\n");

// ---------------------------------------------------------------------------
// System prompt + snapshot del negocio
// ---------------------------------------------------------------------------
async function buildSystem(companyId: string): Promise<string> {
  const [company, productCount, agent, payment, plansSection] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, vertical: true, timezone: true } }),
    prisma.product.count({ where: { companyId } }),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { basePrompt: true } }),
    prisma.paymentConfig.findUnique({ where: { companyId }, select: { enabled: true, methods: { select: { id: true }, take: 1 } } }),
    getLivePlansPromptSection().catch(() => ""),
  ]);
  const vertical = company?.vertical ?? "OTHER";
  return [
    `Eres el COPILOTO DE CONFIGURACIÓN de FlowApp para el negocio "${company?.name ?? "—"}". Ayudas al dueño (usuario NO técnico) a configurar su catálogo CONVERSANDO, en español, rápido y sin formularios.`,
    "",
    `ESTADO DEL NEGOCIO: rubro ${vertical}; ${productCount} producto(s) en el catálogo; pagos ${payment?.enabled && payment.methods.length ? "configurados" : "SIN configurar (recuérdale ir a Pagos)"}; agente ${agent?.basePrompt?.trim() ? "configurado" : "sin prompt (recuérdale ir a Agente IA)"}.`,
    // Fecha/hora actual: necesaria para traducir vigencias relativas ("hasta el
    // domingo", "esta semana") a fechas ISO correctas en las ofertas.
    `FECHA Y HORA ACTUAL: ${new Intl.DateTimeFormat("es-PE", {
      timeZone: company?.timezone || "America/Lima",
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date())} (zona ${company?.timezone || "America/Lima"}).`,
    "",
    rubroGuide(vertical),
    "",
    SYSTEM_GUIDE,
    "",
    plansSection,
    "",
    "REGLAS:",
    "- FLUJO OBLIGATORIO para escribir: primero entiende lo que quiere, luego PROPONLE un resumen claro y espera su CONFIRMACIÓN ('sí', 'dale', 'confirmo'). SOLO entonces llama las herramientas de escritura. NUNCA escribas sin confirmación previa en esta conversación.",
    "- Si el usuario envía una FOTO (carta, lista de precios, catálogo), LÉELA con cuidado: extrae nombres, precios, secciones y descripciones, y propón los productos completos (con aliases y 1-2 FAQs razonables por producto cuando ayuden a vender). No inventes lo que no se ve — pregunta lo que falte.",
    "- Las imágenes adjuntadas también puedes DEJARLAS como fotos del producto con adjuntar_foto_producto: usa la URL EXACTA que aparece en la línea [Adjuntos de este mensaje: …] del mensaje del usuario (NUNCA un data:URI ni una URL inventada). Si el usuario ya adjuntó la imagen, NO le pidas re-adjuntarla. Si el usuario manda la foto DE un producto específico, ofrécele adjuntarla como foto principal. OJO: la foto de una CARTA/lista de precios es del menú completo — NO la adjuntes a cada producto salvo que el usuario lo pida.",
    "- Además de productos, puedes configurar la EMPRESA (nombre, zona horaria, delivery, horario de atención, firma), el AGENTE IA (prompt, estilo, reglas, comportamiento comercial), los PAGOS manuales (Yape/Plin/cuentas, modo de cobro, WhatsApp de avisos), el CRM COMPLETO (crear, renombrar, cambiar colores, reordenar y eliminar tableros/columnas/etiquetas; mover o etiquetar clientes por teléfono), el CHAT WEB (bienvenida/color/dominios), los RECORDATORIOS automáticos (carrito abandonado, dejado en visto, horario permitido) y las RESPUESTAS RÁPIDAS del asesor (atajos /comando con secuencias de texto/multimedia que un humano envía desde Conversaciones — el bot no las usa solo; los adjuntos de esta conversación sirven como multimedia de la secuencia). Usa ver_configuracion / ver_crm / ver_respuestas_rapidas antes de proponer cambios en esas áreas.",
    "- HONESTIDAD DE ACCIONES: solo puedes hacer lo que tus herramientas permiten. Si no tienes herramienta para algo, DILO claramente y sugiere dónde hacerlo en el panel. NUNCA digas que actualizaste, cambiaste o eliminaste algo sin haber llamado la herramienta correspondiente y recibido ok.",
    "- RECORDATORIOS: los generales del negocio van por configurar_recordatorios; los PROPIOS de un producto (y la renovación de streaming) van en el campo reminderConfig del producto (actualizar_producto). Una secuencia post-venta PROGRAMADA (días después de la compra) NO existe como configuración: si te la piden, ofrece los mensajes post-entrega (digitalDelivery.followupMessages, inmediatos tras entregar) y dilo con honestidad.",
    "- ONBOARDING de un negocio nuevo (catálogo vacío): el ORDEN correcto es (1) confirmar rubro y datos de la empresa — el rubro se BLOQUEA en cuanto existan productos —, (2) crear los productos, (3) configurar pagos, (4) ajustar el agente. Guía al usuario en ese orden sin abrumarlo.",
    "- actualizar_producto/configurar_empresa/configurar_agente/configurar_pagos son PARCIALES y ADITIVOS: envía solo los campos a cambiar; el resto se conserva, y las LISTAS enviadas (beneficios, FAQs, aliases, variantes, métodos de pago, reglas, dominios, mensajes) se AGREGAN/FUSIONAN con lo existente — NUNCA borran nada por sí solas. Para QUITAR un elemento o reescribir una lista completa: lee lo actual (ver_producto/ver_configuracion), confirma con el usuario QUÉ se elimina, y llama la tool con el flag reemplazar*/reemplazar=true enviando la versión FINAL completa.",
    "- eliminar_producto: SOLO si lo pidió explícitamente y confirmó el nombre. Nunca elimines por iniciativa propia.",
    "- No gestionas datos sensibles (API keys de OpenAI, tokens de Mercado Pago/Meta, credenciales de WhatsApp): para eso indícale la página del panel correspondiente (Agente IA, Pagos, WhatsApp API).",
    "- DUDAS DE USO DEL SISTEMA (cómo conectar WhatsApp, dónde está algo, planes, integraciones...): responde ÚNICAMENTE con la GUÍA DEL SISTEMA y los PLANES VIGENTES de este prompt, nombrando la página del menú y sus pasos reales. Si algo no está en la guía, dilo con honestidad y sugiere el Centro de ayuda (/ayuda) o la capacitación en Activación (/activacion). NUNCA inventes pasos, botones ni limitaciones (ej.: la conexión por QR SÍ existe, vía SMS Tools). Para preguntas sobre el plan del propio negocio usa ver_mi_plan.",
    "- Tras crear/modificar, resume QUÉ quedó hecho y sugiere el siguiente paso (revisar en el panel, probar en el simulador...).",
    "- Respuestas cortas y claras. Una pregunta a la vez. Los datos que devuelven las herramientas son la fuente de verdad.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
export async function copilotChatController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const body = req.body as CopilotBody;

  const agentConfig = await prisma.agentConfig.findUnique({ where: { companyId } });
  if (!agentConfig?.openaiApiKey) {
    throw new AppError("Falta la API key de IA. Configúrala en Configuración del Agente para usar el Copiloto.", 422);
  }
  const { apiKey, model, baseUrl, caps } = resolveAiSettings(agentConfig);

  const system = await buildSystem(companyId);
  const history = body.messages.slice(-HISTORY_LIMIT);

  // Adjuntos disponibles en TODA la conversación (para adjuntar_foto_producto,
  // incluso si la imagen se envió turnos atrás).
  const attachmentsByUrl = new Map<string, CopilotAttachment>();
  for (const m of body.messages) {
    for (const a of m.attachments ?? []) attachmentsByUrl.set(a.url, a);
  }

  // Las imágenes del historial se inlinean SIEMPRE como data-URI: evita que el
  // proveedor tenga que descargarlas de nuestros uploads (OpenAI daba "Timeout
  // while downloading") y es obligatorio en Anthropic/Gemini. La URL original
  // sigue siendo la identidad del adjunto (attachmentsByUrl / adjuntar_foto_producto).
  const visionUrl = new Map<string, string>();
  {
    const allUrls = new Set(
      body.messages.flatMap((m) => [...(m.attachments?.map((a) => a.url) ?? []), ...(m.imageUrls ?? [])]),
    );
    await Promise.all(
      [...allUrls].map(async (url) => visionUrl.set(url, await prepareImageUrl(url, { inlineImages: true }))),
    );
  }

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map((m): ChatMessage => {
      const urls = [...(m.attachments?.map((a) => a.url) ?? []), ...(m.imageUrls ?? [])];
      if (m.role === "user" && urls.length) {
        const parts: ContentPart[] = [
          // Las URLs canónicas van como TEXTO: con proveedores que inlinean las
          // imágenes (data-URI) el modelo no puede leerlas del image_url, y
          // adjuntar_foto_producto necesita la URL real del adjunto.
          { type: "text", text: `${m.content}\n[Adjuntos de este mensaje: ${urls.join(" | ")}]` },
          ...urls.map((url): ContentPart => ({ type: "image_url", image_url: { url: visionUrl.get(url) ?? url } })),
        ];
        return { role: "user", content: parts };
      }
      return { role: m.role, content: m.content };
    }),
  ];

  let wroteAny = false;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const r = await chatCompletion({
      apiKey,
      model,
      baseUrl,
      temperature: 0.3,
      maxTokens: 2500,
      messages,
      tools: TOOLS,
      toolChoice: "auto",
    });

    if (!r.toolCalls.length) {
      return res.json({ reply: r.content?.trim() || "¿En qué te ayudo con la configuración? 🙂", wrote: wroteAny });
    }

    messages.push({ role: "assistant", content: r.content, tool_calls: r.toolCalls });
    for (const call of r.toolCalls) {
      let parsedArgs: LooseData = {};
      try {
        parsedArgs = JSON.parse(call.function.arguments || "{}");
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: "argumentos JSON inválidos" }) });
        continue;
      }
      try {
        const { result, wrote } = await runCopilotTool(companyId, call.function.name, parsedArgs, attachmentsByUrl);
        wroteAny = wroteAny || wrote;
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : "error ejecutando la herramienta";
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: message }) });
      }
    }
  }

  return res.json({
    reply: "Hice varias operaciones seguidas y me quedé sin turno 😅. Dime si seguimos con lo que faltó.",
    wrote: wroteAny,
  });
}
