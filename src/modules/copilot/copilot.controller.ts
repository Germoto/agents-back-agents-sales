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
import { decryptCredential } from "../../lib/credentials-crypto";
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
        "Modifica un producto existente. `data` es PARCIAL: envía SOLO los campos a cambiar (el resto se conserva). Llámala SOLO tras la confirmación del usuario.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "data"],
        properties: {
          productId: { type: "string" },
          data: { type: "object", description: "Solo los campos a cambiar" },
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
        "Actualiza el AGENTE IA. `data` es PARCIAL: {basePrompt?, salesStyle? (cercano|profesional|directo|entusiasta|consultivo), rules?: string[], negotiationHandoff?, catalogMode? (preguntar|resumen_humano|primeros_n), keywordMode? (detalle_y_preguntar|agregar_directo|auto), trackStock?, catalogMediaMode? (text|media|both)}. NUNCA gestiona la API key ni el modelo. Llámala SOLO tras confirmación.",
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
        "Modifica una respuesta rápida. `data` es PARCIAL: {title?, command?, category?, messages?} (messages REEMPLAZA la secuencia completa si viene). Llámala tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["quickReplyId", "data"],
        properties: {
          quickReplyId: { type: "string" },
          data: { type: "object", description: "Solo los campos a cambiar" },
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
        "Actualiza el CHAT WEB embebible. `data` es PARCIAL: {enabled?, welcomeMessage?, accentColor? (hex), allowedOrigins?: string[] (dominios permitidos, [] = cualquiera)}. El token del widget NO se gestiona por chat. Llámala SOLO tras confirmación.",
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
      name: "configurar_recordatorios",
      description:
        "Actualiza los RECORDATORIOS automáticos. `data` es PARCIAL: {abandonedCart? {enabled, steps: [{delaySeconds, message}]}, leftOnRead? {enabled, steps: [...]}, quietHours? {startHour 0-23, endHour 1-24}}. delaySeconds en segundos (ej. 3600 = 1 hora). Llámala SOLO tras confirmación.",
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
        "Actualiza los PAGOS manuales. `data` es PARCIAL: {enabled?, notificationPhone? (WhatsApp donde avisar pagos), methods?: [{method (ej. 'Yape','Plin','BCP'), number, holder}] (REEMPLAZA la lista completa si viene), paymentMode? (BEFORE_DELIVERY|CASH_ON_DELIVERY|MANUAL|CUSTOMER_CHOICE)}. Tokens de Mercado Pago NO (dirige a Pagos). Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["data"],
        properties: { data: { type: "object", description: "Solo los campos a cambiar" } },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Guía de campos por rubro (espejo compacto de los blueprints del panel)
// ---------------------------------------------------------------------------
const COMMON_FIELDS =
  "Campos comunes de `data`: name*, price* (texto, ej. '12' o '12.50'), shortDescription (1 línea vendedora), fullDescription, category, active (default true), aliases (string[] — sinónimos/abreviaturas con las que el cliente lo nombraría), benefits (string[]), includes (string[]), bonuses (string[]), faqs ([{question, answer}]), objections ([{question, answer}]), attributes (objeto clave→valor, ej. {\"Ingredientes\": \"pollo, papas\"}). " +
  "reminderConfig (recordatorios PROPIOS de este producto — si no se envía, hereda los generales del negocio): {abandonedCart?: {enabled, steps: [{delaySeconds (SEGUNDOS, ej. 3600=1h, 86400=24h), message}]}, leftOnRead?: {enabled, steps: [...]}}; enviar null lo limpia (vuelve a heredar).";

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

/**
 * Construye el ProductPayload COMPLETO fusionando la data parcial del modelo
 * sobre el producto existente (o defaults si es creación). Solo se reemplazan
 * las claves presentes en `data` — updateProduct reescribe relaciones, así que
 * el merge server-side evita que el modelo borre FAQs/variants por accidente.
 */
function buildPayload(data: LooseData, existing: AdminProduct | null) {
  const e = existing;
  const name = asStr(data.name) ?? e?.name ?? "";
  return {
    slug: e?.slug ?? slugify(name),
    active: typeof data.active === "boolean" ? data.active : (e?.active ?? true),
    showInCatalog: typeof data.showInCatalog === "boolean" ? data.showInCatalog : (e?.showInCatalog ?? true),
    pauseHumanAfterSale: e?.pauseHumanAfterSale ?? false,
    productType: (asStr(data.productType) as "DIGITAL" | "PHYSICAL" | undefined) ?? e?.productType,
    name,
    price: asStr(data.price) ?? e?.price ?? "",
    regularPrice: data.regularPrice !== undefined ? asStr(data.regularPrice) ?? null : (e?.regularPrice ?? null),
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
    attributes:
      data.attributes !== undefined
        ? ((data.attributes ?? null) as Record<string, string> | null)
        : ((e?.attributes ?? null) as Record<string, string> | null),
    category: data.category !== undefined ? asStr(data.category) ?? null : (e?.category ?? null),
    verticalData:
      data.verticalData !== undefined
        ? ((data.verticalData ?? null) as Record<string, unknown> | null)
        : (e?.verticalData ?? null),
    reminderConfig:
      data.reminderConfig !== undefined
        ? ((data.reminderConfig ?? null) as Record<string, unknown> | null)
        : ((e?.reminderConfig ?? null) as Record<string, unknown> | null),
    sortOrder: e?.sortOrder,
    aliases: asStrList(data.aliases) ?? e?.aliases ?? [],
    benefits: asOrdered(data.benefits) ?? (e?.benefits ?? []).map((v: string, i: number) => ({ value: v, sortOrder: i })),
    includes: asOrdered(data.includes) ?? (e?.includes ?? []).map((v: string, i: number) => ({ value: v, sortOrder: i })),
    bonuses: asOrdered(data.bonuses) ?? (e?.bonuses ?? []).map((v: string, i: number) => ({ value: v, sortOrder: i })),
    faqs: asQa(data.faqs) ?? (e?.faqs ?? []),
    objections: asQa(data.objections) ?? (e?.objections ?? []),
    files: (e?.files ?? []) as never[],
    digitalDelivery:
      data.digitalDelivery !== undefined
        ? ((data.digitalDelivery ?? null) as never)
        : ((e?.digitalDelivery ?? null) as never),
    physicalDelivery:
      data.physicalDelivery !== undefined
        ? ((data.physicalDelivery ?? null) as never)
        : ((e?.physicalDelivery ?? null) as never),
    variants: Array.isArray(data.variants)
      ? (data.variants as Array<{ name?: unknown; options?: unknown }>).map((v, i) => ({
          name: String(v?.name ?? "").trim(),
          options: asStrList(v?.options) ?? [],
          sortOrder: i,
        })).filter((v) => v.name)
      : (e?.variants ?? []).map((v: { name: string; options: string[]; sortOrder: number }) => ({
          name: v.name,
          options: v.options,
          sortOrder: v.sortOrder,
        })),
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
      const meta = attachmentsByUrl.get(url);
      if (!meta) {
        return {
          result: JSON.stringify({ ok: false, error: "esa URL no corresponde a un adjunto de esta conversación; pide al usuario que envíe la imagen" }),
          wrote: false,
        };
      }
      const productId = String(args.productId ?? "");
      const existing = await getProduct(companyId, productId);
      const principal = args.principal === true;
      const currentFiles = (existing.files ?? []) as Array<{ sortOrder: number } & Record<string, unknown>>;
      if (currentFiles.some((f) => f.url === url)) {
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
      const payload = buildPayload((args.data ?? {}) as LooseData, existing);
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
      const rules = Array.isArray(data.rules) ? (data.rules as unknown[]).map(String).filter((r) => r.trim()) : undefined;
      await upsertAgentConfig(companyId, {
        openaiModel: current.openaiModel,
        // Sin openaiApiKey: la key guardada se conserva (nunca se gestiona por chat).
        temperature: Number(current.temperature),
        basePrompt: asStr(data.basePrompt) ?? current.basePrompt,
        salesStyle: asStr(data.salesStyle) ?? current.salesStyle,
        rules: rules ?? ((current.rules as string[]) ?? []),
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
      const finalMethods =
        methods ?? (current?.methods ?? []).map((m) => ({ method: m.method, number: m.number, holder: m.holder, sortOrder: m.sortOrder }));
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
        messages: Array.isArray(data.messages) ? data.messages : (current.messages as unknown[]),
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
      const updated = await updateWebchatConfig(companyId, {
        ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}),
        ...(data.welcomeMessage !== undefined ? { welcomeMessage: String(data.welcomeMessage ?? "") } : {}),
        ...(data.accentColor !== undefined ? { accentColor: String(data.accentColor ?? "") } : {}),
        ...(data.allowedOrigins !== undefined ? { allowedOrigins: asStrList(data.allowedOrigins) ?? [] } : {}),
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

    default:
      return { result: JSON.stringify({ ok: false, error: `herramienta desconocida: ${name}` }), wrote: false };
  }
}

// ---------------------------------------------------------------------------
// System prompt + snapshot del negocio
// ---------------------------------------------------------------------------
async function buildSystem(companyId: string): Promise<string> {
  const [company, productCount, agent, payment] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, vertical: true } }),
    prisma.product.count({ where: { companyId } }),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { basePrompt: true } }),
    prisma.paymentConfig.findUnique({ where: { companyId }, select: { enabled: true, methods: { select: { id: true }, take: 1 } } }),
  ]);
  const vertical = company?.vertical ?? "OTHER";
  return [
    `Eres el COPILOTO DE CONFIGURACIÓN de FlowApp para el negocio "${company?.name ?? "—"}". Ayudas al dueño (usuario NO técnico) a configurar su catálogo CONVERSANDO, en español, rápido y sin formularios.`,
    "",
    `ESTADO DEL NEGOCIO: rubro ${vertical}; ${productCount} producto(s) en el catálogo; pagos ${payment?.enabled && payment.methods.length ? "configurados" : "SIN configurar (recuérdale ir a Pagos)"}; agente ${agent?.basePrompt?.trim() ? "configurado" : "sin prompt (recuérdale ir a Agente IA)"}.`,
    "",
    rubroGuide(vertical),
    "",
    "REGLAS:",
    "- FLUJO OBLIGATORIO para escribir: primero entiende lo que quiere, luego PROPONLE un resumen claro y espera su CONFIRMACIÓN ('sí', 'dale', 'confirmo'). SOLO entonces llama las herramientas de escritura. NUNCA escribas sin confirmación previa en esta conversación.",
    "- Si el usuario envía una FOTO (carta, lista de precios, catálogo), LÉELA con cuidado: extrae nombres, precios, secciones y descripciones, y propón los productos completos (con aliases y 1-2 FAQs razonables por producto cuando ayuden a vender). No inventes lo que no se ve — pregunta lo que falte.",
    "- Las imágenes adjuntadas también puedes DEJARLAS como fotos del producto con adjuntar_foto_producto (usa la URL exacta del adjunto). Si el usuario manda la foto DE un producto específico, ofrécele adjuntarla como foto principal. OJO: la foto de una CARTA/lista de precios es del menú completo — NO la adjuntes a cada producto salvo que el usuario lo pida.",
    "- Además de productos, puedes configurar la EMPRESA (nombre, zona horaria, delivery, horario de atención, firma), el AGENTE IA (prompt, estilo, reglas, comportamiento comercial), los PAGOS manuales (Yape/Plin/cuentas, modo de cobro, WhatsApp de avisos), el CRM COMPLETO (crear, renombrar, cambiar colores, reordenar y eliminar tableros/columnas/etiquetas; mover o etiquetar clientes por teléfono), el CHAT WEB (bienvenida/color/dominios), los RECORDATORIOS automáticos (carrito abandonado, dejado en visto, horario permitido) y las RESPUESTAS RÁPIDAS del asesor (atajos /comando con secuencias de texto/multimedia que un humano envía desde Conversaciones — el bot no las usa solo; los adjuntos de esta conversación sirven como multimedia de la secuencia). Usa ver_configuracion / ver_crm / ver_respuestas_rapidas antes de proponer cambios en esas áreas.",
    "- HONESTIDAD DE ACCIONES: solo puedes hacer lo que tus herramientas permiten. Si no tienes herramienta para algo, DILO claramente y sugiere dónde hacerlo en el panel. NUNCA digas que actualizaste, cambiaste o eliminaste algo sin haber llamado la herramienta correspondiente y recibido ok.",
    "- RECORDATORIOS: los generales del negocio van por configurar_recordatorios; los PROPIOS de un producto (y la renovación de streaming) van en el campo reminderConfig del producto (actualizar_producto). Una secuencia post-venta PROGRAMADA (días después de la compra) NO existe como configuración: si te la piden, ofrece los mensajes post-entrega (digitalDelivery.followupMessages, inmediatos tras entregar) y dilo con honestidad.",
    "- ONBOARDING de un negocio nuevo (catálogo vacío): el ORDEN correcto es (1) confirmar rubro y datos de la empresa — el rubro se BLOQUEA en cuanto existan productos —, (2) crear los productos, (3) configurar pagos, (4) ajustar el agente. Guía al usuario en ese orden sin abrumarlo.",
    "- actualizar_producto/configurar_empresa/configurar_agente/configurar_pagos son PARCIALES: envía solo los campos a cambiar; el resto se conserva solo.",
    "- eliminar_producto: SOLO si lo pidió explícitamente y confirmó el nombre. Nunca elimines por iniciativa propia.",
    "- No gestionas datos sensibles (API keys de OpenAI, tokens de Mercado Pago/Meta, credenciales de WhatsApp): para eso indícale la página del panel correspondiente (Agente IA, Pagos, WhatsApp API).",
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
    throw new AppError("Falta la API key de OpenAI. Configúrala en Configuración del Agente para usar el Copiloto.", 422);
  }
  const apiKey = decryptCredential(agentConfig.openaiApiKey);
  const model = agentConfig.openaiModel || "gpt-4o-mini";

  const system = await buildSystem(companyId);
  const history = body.messages.slice(-HISTORY_LIMIT);

  // Adjuntos disponibles en TODA la conversación (para adjuntar_foto_producto,
  // incluso si la imagen se envió turnos atrás).
  const attachmentsByUrl = new Map<string, CopilotAttachment>();
  for (const m of body.messages) {
    for (const a of m.attachments ?? []) attachmentsByUrl.set(a.url, a);
  }

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map((m): ChatMessage => {
      const urls = [...(m.attachments?.map((a) => a.url) ?? []), ...(m.imageUrls ?? [])];
      if (m.role === "user" && urls.length) {
        const parts: ContentPart[] = [
          { type: "text", text: m.content },
          ...urls.map((url): ContentPart => ({ type: "image_url", image_url: { url } })),
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
