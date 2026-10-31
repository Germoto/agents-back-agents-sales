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
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { generateImage, saveGeneratedImage, type ImageGenSize, type ImageGenQuality } from "../../lib/image-gen";
import { symbolFor } from "../../lib/currency";
import { storagePathFromUrl, resolveOwnUpload } from "../../lib/uploads";
import { AppError } from "../../lib/app-error";
import { chatCompletion, type ChatMessage, type ContentPart, type ToolDefinition } from "../../lib/openai";
import { productBodySchema } from "../products/products.schemas";
import { createProduct, updateProduct, deleteProduct, getProduct } from "../products/products.service";
import { updateBusinessProfile, type DeliveryConfigInput } from "../business/business.service";
import { upsertAgentConfig, updateAgentReminders } from "../agent-config/agent-config.service";
import { upsertPaymentConfig, updateMercadoPagoConfig } from "../payment-config/payment-config.service";
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
import { getDashboardStats } from "../dashboard/dashboard.service";
import { approveReceipt, associateReceiptProduct, ignoreReceipt, listReceipts, rejectReceipt } from "../receipts/receipts.service";
import { listOrders, updateOrderStatus } from "../orders/orders.service";
import { createNote, deleteCustomer, getCustomer, listNotes, updateCustomer, removeCustomerFlowVars } from "../customers/customers.service";
import { listCrmStructure } from "../crm/crm.service";
import { crmToolConfigSchema } from "../agent-config/agent-config.schemas";
import {
  listConversations,
  listConversationMessages,
  setConversationPinned,
  setCustomerOptOut,
  sendHumanReply,
  sendHumanMedia,
  setBotPaused,
  setHumanReason,
  reactToMessage,
  scheduleManualReminder,
  startConversation,
  resetConversation,
} from "../agent/conversation.service";
import { loadWhatsappSender, mediaKindFor } from "../agent/outbound";
import { checkManualSendGate, COPILOT_SOURCE } from "../agent/manual-send-gate";
import { sendQuickReply } from "../quick-replies/quick-replies.service";
import { cancelPendingReminders } from "../scheduler/scheduler.service";
import { Prisma, ScheduledMessageType } from "@prisma/client";
import { createBooking, createScheduleBlock, deleteScheduleBlock, listBookings, listScheduleBlocks, rescheduleBooking, updateBookingStatus } from "../bookings/bookings.service";
import type { OrderStatus, ServiceBookingStatus } from "@prisma/client";
import { listCampaigns, getCampaign, listRecipients, createCampaign, updateCampaign, deleteCampaign, startCampaign, pauseCampaign, resumeCampaign, cancelCampaign, testCampaign, buildExclusionSets, filterAudience } from "../campaigns/campaigns.service";
import type { CampaignAction } from "../campaigns/campaigns.types";
import { listResourceLibrary, type ResourceType as LibraryResourceType } from "../products/resource-library";
import { parseSendConfig, DEFAULT_SEND_CONFIG, AUTO_PAUSE_AFTER_FAILURES, type CampaignSendConfig, type CampaignMessageItem } from "../campaigns/campaigns.types";
import { createSubscription, listSubscriptions, markCancelled, markRenewed } from "../subscriptions/subscriptions.service";
import { createCredentials, credentialStats, deleteCredential, listCredentials, updateCredential } from "../streaming-inventory/streaming-inventory.service";
import { getReportConfig, sendReport, updateReportConfig } from "../reports/reports.service";
import { createFlow, getFlow, listFlows, toggleFlow, updateFlow } from "../flows/flows.service";
import { AUTHORING_HINTS, AUTHORING_EXAMPLE, HARD_RULES, NODE_DOCS, buildBusinessContext, describeFlow, describeTrigger, normalizeFlowDraft } from "../flows/flow-authoring";
import { getEntitlements } from "../billing/entitlements";
import type { FlowEdge, FlowNode, FlowTrigger } from "../flows/flow-types";
import { getMetaCapiConfig, updateMetaCapiConfig } from "../meta-capi/meta-capi.service";
import {
  listPendingReminders,
  listReminderHistory,
  cancelRemindersByIds,
  cancelRemindersByFilter,
  updateScheduledReminder,
  LISTABLE_TYPES,
} from "../scheduler/scheduler.service";
import { approveStoreOrder, createCoupon, deleteStoreOrder, getStorefrontConfig, listCoupons, listStoreOrders, rejectStoreOrder, storeMetrics, updateCoupon, updateStorefrontConfig } from "../storefront/storefront.service";
import { listStoreEmails } from "../storefront/storefront-email.service";
import { createCampaign as createEmailCampaign, listCampaigns as listEmailCampaigns, previewAudience as previewEmailAudience, sendCampaignTest as sendEmailCampaignTest, startCampaign as startEmailCampaign } from "../storefront/storefront-campaigns.service";
import { updateStorefrontConfigSchema } from "../storefront/storefront.schemas";
import { normalizeQuietHours, normalizePacing } from "../scheduler/quiet-hours";
import { ScheduledMessageStatus } from "@prisma/client";
import { buildBotConfig } from "../bot/bot.service";
import { buildFichaPreview } from "../agent/agent-tools";
import {
  listAdCatalog,
  createAdCatalogEntry,
  updateAdCatalogEntry,
  deleteAdCatalogEntry,
} from "../ad-catalog/ad-catalog.service";
import { prepareImageUrl, resolveAiSettings } from "../../lib/ai-providers";

const MAX_ITERATIONS = 8;
const HISTORY_LIMIT = 16;

export interface CopilotAttachment {
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
// Exportadas también para el conector MCP (mismas tools, otra puerta).
export const TOOLS: ToolDefinition[] = [
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
      name: "previsualizar_ficha",
      description:
        "Muestra EXACTAMENTE cómo el agente PRESENTA este producto al cliente en WhatsApp: la secuencia real de mensajes (texto de la ficha o mensaje fijo, multimedia de presentación, seguimientos), el modo de presentación y notas de la lógica aplicada (oferta vigente, archivos on-demand, etc.). Úsala para auditar la presentación y proponer mejoras de copy con fundamento.",
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
        "Modifica un producto existente. `data` es PARCIAL y ADITIVO: las listas y objetos enviados (aliases, benefits, faqs, variants, attributes, verticalData...) se FUSIONAN con lo existente SIN borrar nada. Para QUITAR elementos o reescribir una lista, envía reemplazar=true con la versión FINAL completa (lee antes con ver_producto). PRESENTACIÓN también editable en data: presentationMessage (mensaje fijo de la ficha), presentationMessageMediaUrl/presentationMessageMediaType (el BANNER que viaja con la ficha como media+caption; '' lo quita), presentationFollowups [{message, mediaUrl?, mediaType?}] (mensajes adicionales de la presentación — al enviarlos REEMPLAZAN la lista completa). Verifica con previsualizar_ficha. Llámala SOLO tras la confirmación del usuario.",
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
      name: "generar_imagen",
      description:
        "GENERA una imagen con IA (banners de oferta, fotos de producto, creativos) y la guarda en el servidor; devuelve su URL lista para adjuntar donde el usuario pida (banner de presentación, paso de recordatorio, followup, respuesta rápida, campaña o foto de producto con adjuntar_foto_producto). CUESTA DINERO al negocio (~$0.03–0.20 por imagen, con su key de OpenAI) → llámala SOLO tras confirmación. El prompt debe ser DETALLADO (estilo, colores, composición) y todo texto que deba aparecer en la imagen va LITERAL entre comillas y en el idioma correcto (ej.: el banner dice \"SOLO POR HOY S/10\"). Tras generar, muéstrale la URL al usuario para que la APRUEBE antes de adjuntarla; si algo salió mal (tildes, montos), regenera con el prompt corregido.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", description: "Descripción detallada de la imagen; textos a renderizar entre comillas, literales" },
          formato: { type: "string", description: "cuadrado (default) | horizontal | vertical" },
          calidad: { type: "string", description: "normal (default) | alta (más cara y lenta)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_archivo_producto",
      description:
        "Edita la METADATA de un archivo YA SUBIDO de un producto (no sube archivos nuevos): showInPresentation (true = se adjunta al presentar la ficha; false = queda on-demand y el agente lo envía solo si el cliente lo pide), description (ayuda al agente a saber cuándo enviarlo), principal (true = primero de la ficha/catálogo) y adjuntarEnCorreo (true = el archivo va ADJUNTO en el correo de entrega cuando el cliente pide recibir el acceso por email; requiere digitalDelivery.emailEnabled en el producto; si los adjuntos superan 15 MB van como links). Identifica el archivo por su URL exacta o su nombre. Verifica después con previsualizar_ficha. Llámala tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "archivo"],
        properties: {
          productId: { type: "string" },
          archivo: { type: "string", description: "URL exacta o nombre (originalName) del archivo a editar" },
          showInPresentation: { type: "boolean" },
          description: { type: "string" },
          principal: { type: "boolean" },
          adjuntarEnCorreo: { type: "boolean", description: "true = adjuntar en el correo de entrega del producto" },
          privado: { type: "boolean", description: "true = archivo PROTEGIDO: sale de la URL pública y solo se descarga con enlace firmado de 7 días (correo, página de gracias, chat). Para archivos de entrega, no para imágenes de presentación." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_configuracion",
      description:
        "Devuelve la configuración ACTUAL del negocio: empresa (nombre, rubro, zona horaria, delivery, horario de atención), agente IA (prompt/estilo/reglas, sin credenciales), pagos (métodos y modo) y recordatorios (secuencias activas, horario de envío con dispersión al abrir, ritmo anti-bloqueo y tope por hora — valores EFECTIVOS, con defaults aplicados). Úsala antes de proponer cambios.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_empresa",
      description:
        "Actualiza la EMPRESA. `data` es PARCIAL (solo lo que cambia): {name?, timezone?, vertical? (SOLO si aún no hay productos), botMode? ('AI' agente IA | 'FLOW' chatbot de flujos | 'HYBRID' el flujo recibe y califica y luego responde el agente IA; HYBRID y AI requieren key de IA), currency? ('PEN' soles S/ | 'USD' dólares $ — la MONEDA del negocio: TODO el embudo la usa: fichas, carrito, cobro, validación, reportes), deliveryConfig? {cost?, time?, areas?: string[], pickupAvailable?, requiresAddress?}, businessHours? [{day (0=domingo..6=sábado), from 'HH:MM', to 'HH:MM'}], meetingUrl? (enlace FIJO de videollamada Meet/Zoom por defecto para citas online; null lo quita), firmaEnabled?, firmaText?}. Llámala SOLO tras la confirmación del usuario.",
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
        "Actualiza el AGENTE IA. `data` es PARCIAL: {basePrompt?, salesStyle? (cercano|profesional|directo|entusiasta|consultivo), rules?: string[] (se AGREGAN a las existentes; para quitar una usa reemplazarReglas=true con la lista final), negotiationHandoff?, unknownHandoff? (DERIVAR SI NO SABE RESPONDER: si el cliente pregunta algo que no está configurado, el agente no inventa ni promete 'consultar': lo pasa a un asesor con motivo CONSULTA; default false), humanChatAlerts? (avisar al dueño por WhatsApp cuando un cliente escribe en un chat en atención humana, con freno anti-spam; default true), catalogMode? (preguntar|resumen_humano|primeros_n), keywordMode? (detalle_y_preguntar|agregar_directo|auto), trackStock?, catalogMediaMode? (text|media|both), crmTool?}. crmTool = HERRAMIENTA DE CRM DEL AGENTE (apagada por defecto): {enabled, tablero (nombre), columnas: [{columna, cuando}], etiquetas: [{etiqueta, cuando}], quitarEtiquetas: [nombres], soloAvanzar? (default true), maxPorTurno? (1-3, default 1), avisarDueno? (default true)}; null la apaga. CADA columna/etiqueta permitida necesita su regla 'cuando' (mín. 10 caracteres, p. ej. 'Propuesta enviada: cuando el cliente pide la cotización por escrito'): sin ella se rechaza. Recomienda dejar las columnas de entrada al flujo/anuncio y las de pago a la validación de comprobantes. NUNCA gestiona la API key, el proveedor ni el modelo. Llámala SOLO tras confirmación.",
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
        "Crea una RESPUESTA RÁPIDA (atajo que el asesor humano envía con un clic o escribiendo /comando en Conversaciones; el bot NO las envía solo). messages es la secuencia (1-10): texto {type:'text', text} o multimedia {type:'image'|'video'|'audio'|'document', mediaUrl (puede ser un adjunto de esta conversación), text? como caption}. acciones (opcional) = lo que pasa con el CLIENTE al enviarla: {tablero (nombre del tablero del CRM), columna (nombre de la columna a la que se mueve), agregarEtiquetas: string[] (nombres), quitarEtiquetas: string[], marcarEntregado (true = si el chat tiene comprobante pendiente, el panel ofrece marcar la venta como entregada), presentaProducto (nombre del producto que esta respuesta presenta: el bot lo toma como ya presentado)}. Los nombres deben existir (ver_crm / listar_productos); si no, la tool falla sin crear nada. Llámala tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "messages"],
        properties: {
          title: { type: "string" },
          command: { type: "string", description: "Atajo, ej. '/gracias' (opcional, único por negocio)" },
          category: { type: "string", description: "Nombre de la categoría (se crea si no existe)" },
          messages: { type: "array", items: { type: "object" }, description: "Secuencia de mensajes" },
          acciones: { type: "object", description: "{tablero?, columna?, agregarEtiquetas?, quitarEtiquetas?, marcarEntregado?, presentaProducto?} por NOMBRES" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_respuesta_rapida",
      description:
        "Modifica una respuesta rápida. `data` es PARCIAL: {title?, command?, category?, messages?, acciones?}. Los messages enviados se AGREGAN al final de la secuencia; para reescribirla o quitar mensajes usa reemplazarMensajes=true con la secuencia final completa. acciones se fusiona campo a campo: {tablero, columna, agregarEtiquetas, quitarEtiquetas, marcarEntregado, presentaProducto} por NOMBRES; un campo en null lo quita (tablero: null quita el movimiento de CRM; agregarEtiquetas: null quita todas). Llámala tras confirmación.",
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
        "Mueve un CLIENTE a una columna del CRM, le asigna/quita etiquetas y/o le quita respuestas del chatbot de flujos (📝 en su tarjeta). Identifica al cliente por su teléfono. Usa ver_crm para los ids de tablero/columna y los NOMBRES exactos de etiquetas.",
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
          quitarRespuestasFlujo: {
            type: "array",
            items: { type: "string" },
            description: "Claves de respuestas del chatbot a borrar de la ficha (las ves en ver_crm / leer_conversacion → respuestasDelFlujo); [\"*\"] = todas. El agente dejará de darlas por conocidas y las volverá a preguntar. Solo tras confirmación.",
          },
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
      name: "ver_tienda",
      description:
        "TIENDA WEB pública del negocio (<slug>.flowapp.pe): devuelve si está activa, su URL, el checklist de requisitos (identificador/slug válido, módulos del plan, Mercado Pago configurado, Yape/Plin disponible = métodos manuales de Pagos + opción de la tienda, productos elegibles = digitales con entrega por correo activa, productos que faltan por habilitar), la configuración visual, los últimos pedidos web con su estado (PENDIENTE/EN_REVISION/PAGADO/ENTREGADO/FALLIDO), las MÉTRICAS (7/30/90 días con `dias`; visitas únicas, vistas de producto, carrito, checkouts, clics a WhatsApp, compras, ingresos, conversión % y tabla por producto) y los pedidos EN_REVISION (comprobante Yape/Plin subido sin validación automática: incluye id, comprador, monto, nombre del pagador, lo que la visión leyó y la URL del comprobante). Úsala antes de proponer cambios, cuando pregunten por ventas de la tienda o antes de aprobar/rechazar un pedido.",
      parameters: { type: "object", additionalProperties: false, properties: { pedidos: { type: "number", description: "cuántos pedidos recientes incluir (default 10, máx 50)" }, dias: { type: "number", description: "periodo de las métricas hacia atrás (default 30, máx 365); se ignora si mandas desde/hasta" }, desde: { type: "string", description: "YYYY-MM-DD (zona horaria del negocio)" }, hasta: { type: "string", description: "YYYY-MM-DD" }, productId: { type: "string", description: "métricas solo de ese producto" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_tienda",
      description:
        "Activa o configura la TIENDA WEB. `data` es PARCIAL y SE FUSIONA con lo guardado: manda SOLO los campos a cambiar y, en productOverrides, SOLO el producto que cambia y SOLO sus campos (lo demás se conserva; `null` borra un campo o el override entero del producto). OJO: las LISTAS se reemplazan completas cuando se envían (media, categories, hiddenImages, heroSlides, trustItems, faqs, productIds, volumePricing.tiers, emailReminders.*.steps, landing.stats/testimonials): para agregar o quitar un elemento, léela primero con ver_tienda y reenvía la lista completa. {enabled?, title? (nombre visible), tagline? (frase corta), accentColor? (hex), logoUrl? (URL de una imagen subida a FlowApp, p. ej. de adjuntar_foto_producto/generar_imagen; null quita el logo), whatsappNumber? (botón 'Escríbenos', solo dígitos con código de país), productIds? (uuid[]; vacío = todos los elegibles), manualPaymentsEnabled? (aceptar Yape/Plin en la tienda subiendo el comprobante; usa los métodos manuales de Pagos; default true), heroSlides? (PORTADA/carrusel: hasta 5 [{productId (elegible), style: 'ambiente' (banner desenfocado de fondo + imagen a la derecha, default) | 'tarjeta' (imagen grande + tarjeta blanca de compra) | 'poster' (imagen a sangre con el texto fundido encima), kicker ('LO MÁS VENDIDO'), headline, highlight (palabras EXACTAS del headline que van en color de acento), sub, bullets (hasta 3 frases cortas: chips en ambiente, lista ✓ en tarjeta), socialProof ('+2,300 compras'), accentColor (hex, default rosa #ff2d8a), ctaColor (hex, default amarillo #ffd400), ctaLabel ('Comprar ahora'), imageUrl? (URL de una imagen del producto — ver_tienda → productosElegibles[].images — o subida con adjuntar_foto_producto/generar_imagen; vacío = portada del producto), bg? (hex oscuro de fondo)}]; precio, precio anterior, -% y cuenta regresiva salen del producto (offerEndsAt)), carouselAutoplay?, carouselIntervalSec? (3-12), showOldPrice? (precio anterior tachado y -%), trustItems? (hasta 4 [{icon? (emoji), title, sub}]; null = por defecto), faqs? (OBSOLETO: ya no se muestra; usa productOverrides[id].landing.faqHiddenIds/faqExtra), footerTagline?, emailReminders? (CORREOS AUTOMÁTICOS de la tienda: {abandonedCheckout: {enabled, steps: [{delayMinutes, subject, body, couponCode?, couponByProduct? ({[productId]: code} cupón distinto según el producto del pedido; vacío = couponCode)}] hasta 3}, postPurchase: {enabled, delayDays, subject, body, couponCode?, couponByProduct?}, welcome: {enabled, subject, body, couponCode?}}; variables {nombre} {producto} {precio} {link} {cupon} {tienda} {relacionado} y spintax {a|b}; checkout abandonado = pedido sin pagar, se cancela solo al pagar), productOverrides? ({[productId]: {imageUrl? (PORTADA en la tienda: URL de una imagen del producto o subida por adjuntar_foto_producto/generar_imagen), hiddenImages? (string[] de URLs de imágenes del producto que la tienda NO muestra — quitar solo de la tienda, el producto del agente no cambia), categories? (string[] hasta 6, tipo etiquetas; alimentan los filtros de la tienda), shortDescription?, sortOrder?, media? ([{url, type: IMAGE|VIDEO|PDF|OTHER, title?, description? (texto vendedor que ve el comprador; sin título ni descripción la tienda muestra solo el archivo), cta? (true = botón de compra debajo del recurso que lleva al checkout de la landing), ctaLabel? ('Comprar ahora')}] RECURSOS DE MUESTRA que se ven en la ficha — usa urls de archivos públicos del producto (ver_tienda → productosElegibles[].files, no privados); PDFs/videos nuevos solo se suben desde el panel), landing? (LANDING DE VENTAS de la ficha: {kicker? ('MEGAPACK DJ 2026'), headline? (titular gancho, default = nombre), ctaLabel? ('Sí, quiero mi Megapack →'), videoUrl? (YouTube/Vimeo o url de un archivo VIDEO del producto; se muestra con póster y botón ▶), stats? (hasta 4 [{value: '+250 GB', label: 'de música'}]), pain? ({kicker, headline, items: hasta 4 frases de dolor ✕, solution: frase ✓}), includesHeadline? (título de 'Lo que recibes hoy'; las tarjetas salen de includes/bonuses del producto: 'Título: detalle' se parte en título y detalle), sample? ({kicker, headline, text, externalUrl (ej. carpeta de Google Drive), externalLabel}; los recursos salen de media; si no se configura nada, la sección muestra solo los recursos sin cabecera), testimonialsHeadline?, testimonials? ([{url, type: IMAGE|VIDEO}] capturas de WhatsApp subidas desde el panel), orderBump? ({productId (otro producto visible), price (precio especial solo en ese checkout), title?, note?}), guarantee? ({enabled, days, title, text}; null = hereda la de la tienda), faqHiddenIds? (ids de las FAQ del producto que NO van en la tienda; ver_tienda → productosElegibles[].faqs trae {id, question, answer}), faqExtra? ([{question, answer}] hasta 10, preguntas SOLO para la tienda; las FAQ de la ficha = las del producto no ocultas + estas)})} | null} — personalización SOLO para la tienda, el producto del chat no cambia; null quita el override), announcement? (BARRA DE ANUNCIO superior: {enabled, text, countdown: 'none' | 'offer' (cuenta regresiva de la oferta más próxima) | fecha ISO}), volumePricing? (COMBOS: {enabled, tiers: hasta 3 [{minQty (≥2), discountPct}] ej. 3 o más → 20 %; allBundle: {enabled, price (precio fijo si el carrito lleva TODOS los productos visibles), label ('Los 6 packs')}}; REGLA: los tramos aplican a carritos parciales; cuando el carrito lleva TODOS los visibles manda el precio fijo de allBundle (aunque un tramo diera más descuento), así que un tramo con minQty ≥ número de productos visibles nunca se aplica; el descuento se calcula solo en el checkout y se muestra en tarjetas, carrito y nudge 'agrega 1 más y ahorras X %' / 'agrega 1 más y llévate todo por S/ X'), salesSettings? ({ctaColor (hex del botón de compra, default amarillo #ffd60a), catalogTitle ('Todo a S/ 10'), comboSection: {kicker, headline, sub, ctaLabel} (usa {precio} para el precio del bundle), guarantee: {enabled, days, title, text} (garantía que ve el comprador en el checkout de la landing; {dias} en el título), cartRecommendations (sugerir 'Completa tu pedido' en el carrito), ctaEffect: 'none' | 'pulse' | 'shine' | 'bounce' (efecto que resalta los botones de compra; default pulse), landingBar: 'top' | 'bottom' | 'both' (dónde aparece la barra fija 'Comprar ahora' de la landing al hacer scroll; default top), footer: {theme: 'auto' (oscuro en la landing, claro en el resto) | 'dark' | 'light', showSubscribe (bloque 'Recibe ofertas y novedades' integrado en el pie), subscribeTitle, subscribeSub, showPayments (línea 'Yape · Plin · Tarjeta · Mercado Pago'), showWhatsapp (enlace 'Escríbenos'), note (texto libre extra), showInfo (línea del negocio: nombre, frase, pagos, WhatsApp, nota; con showSubscribe y showInfo en false no hay pie)}})}. Para que funcione: slug válido (se cambia en configurar_empresa: minúsculas/números/guiones), AL MENOS un cobro: Mercado Pago conectado en Integraciones y habilitado para la tienda (el token NO se gestiona por chat; el canal sí: configurar_pagos {mpStoreEnabled:true}) o Yape/Plin (métodos en configurar_pagos + manualPaymentsEnabled), y productos con digitalDelivery.emailEnabled=true (actualizar_producto). Si enabled=true y falta un requisito, la tool lo explica. Llámala SOLO tras confirmación.",
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
      name: "aprobar_pedido_tienda",
      description:
        "Aprueba un pedido Yape/Plin de la TIENDA WEB que quedó EN_REVISION (o PENDIENTE con comprobante): crea el comprobante APROBADO (validación manual) y ENTREGA el producto por correo (y WhatsApp si dejó número). Antes de llamarla, muestra al dueño el pedido (ver_tienda → pedidosEnRevision: producto, monto, comprador, nombre del pagador, URL del comprobante, lo que leyó la visión) y pide confirmación explícita. Es irreversible (es una venta). Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["orderId"],
        properties: {
          orderId: { type: "string", description: "id del pedido (ver_tienda → pedidosEnRevision[].id)" },
          nota: { type: "string", description: "nota opcional para el comprobante" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_pedido_tienda",
      description:
        "ELIMINA un pedido de la TIENDA WEB (pensado para pedidos de PRUEBA): borra el pedido, sus correos programados/enviados, sus eventos de analítica y el comprobante que creó si nada más lo usa. No toca al cliente ni la conversación. Es IRREVERSIBLE: muestra el pedido (ver_tienda → pedidos) y pide confirmación explícita antes. Llámala SOLO tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["orderId"], properties: { orderId: { type: "string", description: "id del pedido" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "rechazar_pedido_tienda",
      description:
        "Rechaza un pedido Yape/Plin de la TIENDA WEB EN_REVISION (comprobante falso, monto distinto, pago no recibido): lo deja FALLIDO con el motivo; no entrega nada. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["orderId"],
        properties: {
          orderId: { type: "string", description: "id del pedido" },
          motivo: { type: "string", description: "motivo del rechazo (se guarda en el pedido)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_campanas_correo",
      description: "Lista las CAMPAÑAS DE CORREO (promociones) de la tienda web con estado, enviados, fallidos, clics y compras atribuidas.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_campana_correo",
      description:
        "Crea una CAMPAÑA DE CORREO (promoción) para contactos con correo y consentimiento. {name, subject, body (variables {nombre} {correo} {ultimo_producto} {productos_comprados} {dias_desde_compra} {tienda} {cupon} {link} {campo1..3} y spintax), ctaLabel? ('Ver la tienda'), ctaUrl? (vacío = portada de la tienda; o URL de un producto), couponCode?, audience: {source: 'all' (todos con correo) | 'buyers' (compradores de la tienda; productId? limita a quienes compraron ese producto) | 'subscribers' (suscriptores del pie) | 'whatsapp' (contactos de WhatsApp con correo) | 'manual' (solo los de abajo), tagId?, customerIds? (contactos a mano), emails? (correos sueltos), rows? ([{email, nombre, campo1, campo2, campo3, cupon}] para mensajes personalizados por persona)}, enviar?: false (default: queda en BORRADOR para revisar en el panel; true = envía ya), scheduledAt? (ISO para programar)}. Antes de crear, muestra al dueño el tamaño de la audiencia (previsualizar_audiencia_correo) y el texto, y pide confirmación. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "subject", "body", "audience"],
        properties: {
          name: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          ctaLabel: { type: "string" },
          ctaUrl: { type: "string" },
          couponCode: { type: "string" },
          audience: { type: "object", description: "ver descripción" },
          enviar: { type: "boolean" },
          scheduledAt: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "previsualizar_audiencia_correo",
      description: "Cuenta cuántos contactos recibirían una campaña de correo con esa audiencia (misma forma que crear_campana_correo.audience) y muestra una muestra.",
      parameters: { type: "object", additionalProperties: false, required: ["audience"], properties: { audience: { type: "object" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_prueba_campana_correo",
      description: "Envía una campaña de correo existente como PRUEBA a un correo (con datos de ejemplo). {campaignId, to}.",
      parameters: { type: "object", additionalProperties: false, required: ["campaignId", "to"], properties: { campaignId: { type: "string" }, to: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_cupones",
      description: "Lista los CUPONES de descuento de la tienda web (código, tipo PERCENT/FIXED, valor, productos a los que aplica, usos/máximo, vencimiento, activo).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_cupon",
      description:
        "Crea un CUPÓN de descuento para la tienda web. {code (3-30 caracteres, se guarda en MAYÚSCULAS), type: 'PERCENT' (value = % 1-100) | 'FIXED' (value = monto en la moneda del negocio), value, productIds? (uuid[]; vacío = todos los productos), maxUses? (límite de usos), expiresAt? (fecha-hora ISO)}. El comprador lo escribe en el checkout de la tienda; el descuento se aplica sobre el precio de lista y el uso se cuenta al pagar. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["code", "type", "value"],
        properties: {
          code: { type: "string" },
          type: { type: "string", enum: ["PERCENT", "FIXED"] },
          value: { type: "number" },
          productIds: { type: "array", items: { type: "string" } },
          maxUses: { type: "number" },
          expiresAt: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_cupon",
      description: "Edita un cupón existente de la tienda web: {couponId, maxUses? (null = sin límite), expiresAt? (ISO; null = sin vencimiento), productIds? (uuid[]; vacío = todos), active?}. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["couponId"],
        properties: {
          couponId: { type: "string" },
          maxUses: { type: ["number", "null"] },
          expiresAt: { type: ["string", "null"] },
          productIds: { type: "array", items: { type: "string" } },
          active: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "desactivar_cupon",
      description: "Desactiva (active=false) o reactiva (active=true) un cupón de la tienda web por id (ver_cupones). Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["couponId"],
        properties: { couponId: { type: "string" }, active: { type: "boolean", description: "default false (desactivar)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_recordatorios",
      description:
        "Actualiza los RECORDATORIOS automáticos. `data` es PARCIAL: {abandonedCart? {enabled, steps: [{delaySeconds, message, offerPrice? (OFERTA ESCALONADA: al enviarse ese paso el agente ofrece/cobra/valida ese precio SOLO a ese cliente; usa {oferta} en el mensaje)}]}, leftOnRead? {enabled, steps: [...]}, quietHours? {startHour 0-23, endHour 1-24, spreadMinutes 0-180 (DISPERSIÓN AL ABRIR: lo acumulado fuera de horario se reparte al azar en los primeros N minutos en vez de salir todo a la hora exacta; default 90)}, pacing? {minSec, maxSec, maxPerHour} (RITMO ANTI-BLOQUEO: separación al azar entre recordatorios de la empresa, default 25-70 s, y tope por hora, default 60)}. delaySeconds en segundos (ej. 3600 = 1 hora). En los mensajes se puede usar SPINTAX {Hola|Buenas|Qué tal} para que cada cliente reciba un texto distinto (anti-bloqueo). Tras un BLOQUEO de WhatsApp, recomienda calentar el número: pacing 60-120 s y maxPerHour 20-30 la primera semana. CÓMO FUNCIONA LA COLA: cada respuesta del bot programa TODOS los pasos de la secuencia de golpe (delaySeconds desde ese momento, no acumulativo); el envío respeta horario, ritmo y tope por hora; si varios pasos de un cliente están vencidos sale SOLO el más reciente (con el precio de la oferta escalonada más avanzada; nunca sube un precio ya ofrecido) y los demás se cancelan; un paso con más de 12 h de atraso vence si ya hay uno más nuevo (48 h si es el último); el paso 1 de cada lead tiene prioridad sobre los atrasados. CAPACIDAD ≈ maxPerHour × horas de envío por día; cada paso extra multiplica la demanda (leads/día × pasos) — antes de AGREGAR pasos o BAJAR el ritmo, compara con listar_recordatorios_programados (total/atrasados) y avisa al dueño si la cola no se va a cubrir. Llámala SOLO tras confirmación.",
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
        "Actualiza los PAGOS manuales. `data` es PARCIAL: {enabled?, notificationPhone? (WhatsApp donde avisar pagos), methods?: [{method (ej. 'Yape','Plin','BCP'), number, holder}] (se FUSIONAN por método+número: agrega nuevos y actualiza titulares; para QUITAR uno usa reemplazarMetodos=true con la lista final completa), paymentMode? (BEFORE_DELIVERY|CASH_ON_DELIVERY|MANUAL|CUSTOMER_CHOICE), mpChatEnabled? / mpStoreEnabled? (MERCADO PAGO POR CANAL: true/false para usar el link de pago en el cobro por chat de WhatsApp y/o en la tienda web; requiere que MP ya esté conectado)}. El Access Token de Mercado Pago NO se gestiona por chat: se conecta en Integraciones. Llámala SOLO tras confirmación.",
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
  // ------------------------- ANÁLISIS (solo lectura) -------------------------
  {
    type: "function",
    function: {
      name: "ver_metricas",
      description:
        "MÉTRICAS del negocio en un rango (default: últimos 30 días) COMPARADAS con el periodo anterior: ingresos, ventas, ticket promedio, unidades, contactos nuevos, conversaciones, TASA DE CONVERSIÓN, embudo (contactos→conversaciones→ventas), top productos, métodos de pago y serie temporal. Es la PRIMERA tool para cualquier pregunta de números.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          desde: { type: "string", description: "YYYY-MM-DD (opcional)" },
          hasta: { type: "string", description: "YYYY-MM-DD (opcional)" },
          productId: { type: "string", description: "Filtrar por un producto (opcional)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_ventas",
      description: "Ventas APROBADAS (pagos validados) con fecha, monto, método, producto y cliente. Default: últimos 30 días.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          desde: { type: "string", description: "YYYY-MM-DD" },
          hasta: { type: "string", description: "YYYY-MM-DD" },
          limit: { type: "number", description: "máx 100 (default 30)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_comprobantes",
      description: "Comprobantes de pago por estado (PENDIENTE, EN_REVISION, APROBADO, RECHAZADO, IGNORADO). Default PENDIENTE.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          estado: { type: "string" },
          desde: { type: "string" },
          hasta: { type: "string" },
          limit: { type: "number", description: "máx 100 (default 30)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_pedidos",
      description: "Pedidos (rubros restaurante/comercial) con código, estado, total, cliente e ítems. Filtro opcional por estado (PEDIDO_REGISTRADO, PENDIENTE_PAGO, PAGADO, DESPACHADO, ENTREGADO...).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { estado: { type: "string" }, limit: { type: "number", description: "máx 100 (default 30)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_conversaciones",
      description:
        "Conversaciones recientes con estado, etapa del embudo (NUEVO/INTERESADO/ESPERANDO_PAGO/PAGADO/ENTREGADO...), si están en atención humana (y por qué), si están fijadas (fijado), si el cliente pidió no ser contactado (noContactar) y el último mensaje. Filtro opcional por etapa.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { etapa: { type: "string" }, limit: { type: "number", description: "máx 100 (default 30)" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "leer_conversacion",
      description:
        "Lee los MENSAJES REALES de la conversación de un cliente (por teléfono). Úsala para analizar objeciones, puntos de fuga y calidad de respuesta del agente antes de proponer mejoras.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone"],
        properties: {
          phone: { type: "string", description: "Teléfono del cliente" },
          limit: { type: "number", description: "máx 100 mensajes (default 50)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fijar_conversacion",
      description: "Fija (o desfija) el chat de un cliente arriba de la lista de Conversaciones del panel. Sin límite de fijados; el panel muestra los 2 más recientes y el resto con 'Ver más'.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["cliente"],
        properties: { cliente: { type: "string", description: "teléfono o id del cliente" }, fijar: { type: "boolean", description: "true = fijar (default), false = desfijar" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_mensaje_cliente",
      description:
        "ESCRIBE al cliente por WhatsApp (o chat web) COMO ASESOR (igual que responder desde el panel): texto y/o un adjunto (imagen, video o PDF por URL). Por defecto pasa el chat a ATENCIÓN HUMANA (el agente IA deja de responder a ese cliente hasta atencion_humana activar:false). Antes lee la conversación con leer_conversacion. Respeta no contactar, la ventana de 24 h (Meta) y el ritmo anti-bloqueo (puede devolver reintentarEnSeg). La firma del negocio se agrega sola. Un mensaje por llamada; no inventes precios ni enlaces (usa ver_producto/ver_configuracion). No crea chats nuevos: para un número sin conversación usa iniciar_conversacion.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone"],
        properties: {
          phone: { type: "string", description: "teléfono (o id) del cliente" },
          mensaje: { type: "string", description: "texto a enviar (opcional si va adjunto; con adjunto es el caption)" },
          mediaUrl: { type: "string", description: "URL http(s) de imagen/video/PDF: archivo del producto, imagen de generar_imagen, recurso de listar_recursos o URL pública" },
          nombreArchivo: { type: "string", description: "nombre visible del PDF/documento (opcional)" },
          citarMensajeId: { type: "string", description: "id de un mensaje de leer_conversacion para responder citándolo (opcional)" },
          pasarAHumano: { type: "boolean", description: "default true: pausa el agente IA en este chat (atención humana). false = solo enviar" },
          motivo: { type: "string", description: "motivo corto que verá el dueño en el panel (ej. 'Copiloto cerrando venta')" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "atencion_humana",
      description:
        "Toma o DEVUELVE el control de un chat. activar:true = pausa el agente IA (atención humana; también cancela sus recordatorios automáticos). activar:false = REACTIVA el bot: el agente vuelve a responder al cliente. Úsala al terminar de atender a alguien por aquí.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone", "activar"],
        properties: {
          phone: { type: "string", description: "teléfono (o id) del cliente" },
          activar: { type: "boolean", description: "true = pausar el bot (humano atiende); false = reactivar el bot" },
          motivo: { type: "string", description: "motivo corto al pausar (lo ve el dueño en el panel)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_respuesta_rapida",
      description:
        "Envía al cliente una RESPUESTA RÁPIDA del asesor (secuencia completa de mensajes/multimedia, con sus acciones de etiquetas/CRM/producto presentado), como el /comando del panel. Busca con ver_respuestas_rapidas. Por defecto toma el control del chat (pausa el agente IA). Respeta no contactar, ventana 24 h y ritmo anti-bloqueo.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone", "respuesta"],
        properties: {
          phone: { type: "string", description: "teléfono (o id) del cliente" },
          respuesta: { type: "string", description: "id, /comando o título de la respuesta rápida" },
          tomarControl: { type: "boolean", description: "default true: pausa el agente IA en este chat" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reaccionar_mensaje",
      description: "Reacciona con un emoji a un mensaje del chat (como en WhatsApp). emoji '' quita la reacción. Necesita el id del mensaje (leer_conversacion). No disponible en chat web.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone", "mensajeId", "emoji"],
        properties: {
          phone: { type: "string", description: "teléfono (o id) del cliente" },
          mensajeId: { type: "string", description: "id del mensaje (de leer_conversacion)" },
          emoji: { type: "string", description: "un emoji, o '' para quitar" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "programar_recordatorio_cliente",
      description:
        "Programa un RECORDATORIO MANUAL para un cliente (como el botón del chat): un mensaje (y opcional multimedia) que sale a la hora indicada aunque el chat esté en atención humana. Lo envía el sistema con su ritmo anti-bloqueo y horario hábil; en Meta fuera de la ventana de 24 h usa la plantilla de respaldo del negocio. Indica enviarEn (fecha-hora ISO en la zona del negocio) o enMinutos.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone", "mensaje"],
        properties: {
          phone: { type: "string", description: "teléfono (o id) del cliente" },
          mensaje: { type: "string" },
          enviarEn: { type: "string", description: "fecha-hora ISO futura (ej. 2026-10-28T18:30:00-05:00)" },
          enMinutos: { type: "number", description: "alternativa: minutos desde ahora" },
          mediaUrl: { type: "string", description: "URL http(s) de imagen/video/PDF (opcional)" },
          mediaType: { type: "string", enum: ["image", "video", "document"], description: "tipo del adjunto (default según extensión)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "iniciar_conversacion",
      description:
        "Abre una conversación NUEVA con un número que aún no tiene chat y envía el primer mensaje como asesor (botón 'Nueva conversación' del panel). No pausa el bot: si el cliente responde, el agente IA continúa. Respeta el ritmo anti-bloqueo; con Meta un número que nunca escribió está fuera de la ventana de 24 h y se rechaza (usa una campaña con plantilla). SOLO tras confirmación del dueño.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone", "mensaje"],
        properties: {
          phone: { type: "string", description: "número con código de país (ej. 51999888777)" },
          mensaje: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reiniciar_conversacion",
      description:
        "REINICIA el chat de un cliente como el botón 'Reiniciar' del panel: borra el historial de mensajes y el carrito, limpia el estado del agente, reactiva el bot y cancela sus recordatorios pendientes. El cliente NO recibe nada. Irreversible: SOLO si el dueño lo pidió explícitamente y confirmó.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["phone"],
        properties: { phone: { type: "string", description: "teléfono (o id) del cliente" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_cliente",
      description: "Ficha de un CLIENTE por teléfono o id: datos (nombre, correo, origen, idioma…), etiquetas, producto en foco, deals y notas internas. Úsala antes de editar.",
      parameters: { type: "object", additionalProperties: false, required: ["cliente"], properties: { cliente: { type: "string", description: "teléfono o id" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_cliente",
      description: "Edita los datos de un CLIENTE (por teléfono o id). `data` PARCIAL: {name?, email?, phone? (corregir el número), sexo?, fechaNacimiento? (YYYY-MM-DD), idioma?, origenDeLead?, noContactar? (true = el cliente pidió que no le escriban: pausa el bot, cancela sus recordatorios y lo excluye de campañas; false = quitar la marca)}. Para CRM/etiquetas usa gestionar_cliente_crm. Llámala tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["cliente", "data"], properties: { cliente: { type: "string" }, data: { type: "object" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "agregar_nota_cliente",
      description: "Agrega una NOTA INTERNA a un cliente (solo la ve el equipo, no se envía).",
      parameters: { type: "object", additionalProperties: false, required: ["cliente", "texto"], properties: { cliente: { type: "string" }, texto: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_cliente",
      description: "ELIMINA un cliente con su conversación, notas y etiquetas. Irreversible: SOLO tras confirmación explícita con nombre y teléfono.",
      parameters: { type: "object", additionalProperties: false, required: ["cliente"], properties: { cliente: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_pedido",
      description: "Cambia el ESTADO de un pedido (rubros restaurante/comercial; listar_pedidos → codigo): PEDIDO_REGISTRADO | EN_COORDINACION | DESPACHADO | CANCELADO | PENDIENTE_PAGO | PAGADO | ENTREGADO. Avisa al cliente igual que el panel. Llámala tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["codigo", "estado"], properties: { codigo: { type: "string", description: "código o id del pedido" }, estado: { type: "string" }, nota: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_cita",
      description: "Crea una CITA/reserva para un cliente (teléfono o id) y un servicio (producto por id o nombre) con fecha-hora ISO (zona del negocio). Valida disponibilidad y programa los recordatorios. Llámala tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["cliente", "servicio", "inicio"], properties: { cliente: { type: "string" }, servicio: { type: "string" }, inicio: { type: "string", description: "ISO, ej. 2026-10-20T15:00:00-05:00" }, modalidad: { type: "string" }, notas: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_cita",
      description: "Cambia el estado de una cita (listar_citas → codigo): SOLICITADA | CONFIRMADA | CANCELADA | COMPLETADA, o la REPROGRAMA con `inicio` (ISO). Llámala tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["codigo"], properties: { codigo: { type: "string", description: "código o id de la cita" }, estado: { type: "string" }, inicio: { type: "string", description: "nueva fecha-hora ISO (reprogramar)" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "bloquear_horario",
      description: "Bloquea un rango de la agenda (vacaciones, feriado, almuerzo): el bot no ofrece citas ahí. {inicio, fin} ISO, motivo opcional. Para ver/quitar bloqueos: listar=true o quitarId.",
      parameters: { type: "object", additionalProperties: false, properties: { inicio: { type: "string" }, fin: { type: "string" }, motivo: { type: "string" }, listar: { type: "boolean" }, quitarId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_citas",
      description: "Citas/reservas (rubros servicios/inmobiliaria) por rango y estado (SOLICITADA, CONFIRMADA, CANCELADA, COMPLETADA).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { desde: { type: "string" }, hasta: { type: "string" }, estado: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_catalogo_anuncios",
      description:
        "CATÁLOGO DE ANUNCIOS (atribución Meta CTWA): las entradas que mapean IDs o títulos de anuncios a una descripción amigable (la que se muestra en los leads y el reporte por anuncio), con su producto vinculado y sus ACCIONES CRM al llegar el lead (etiquetas, tablero/columna).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_anuncio",
      description:
        "Crea/edita/elimina una entrada del CATÁLOGO DE ANUNCIOS. Crear: {description, matchers: [ids o títulos EXACTOS como llegan del anuncio], productId?|productName?, etiquetas?, tablero?, columna?}. Editar: {id, description?, matchers?, productId?|productName?, etiquetas?, tablero?, columna?}. Eliminar: {id, eliminar: true}. El producto vinculado hace que el lead que llegue por ese anuncio entre con ese producto como PRODUCTO EN FOCO. ACCIONES CRM AL LLEGAR (primer mensaje del lead desde ese anuncio): etiquetas (nombres o ids; [] o null las quita) y tablero+columna (nombres o ids; null quita) — p. ej. etiqueta 'Origen: Meta Ads' y columna 'Nuevo lead'. PREFIERE productId (de listar_productos, infalible); productName hace match tolerante (\"\" desvincula). Varios matchers pueden apuntar a la misma descripción. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "id de la entrada (editar/eliminar)" },
          description: { type: "string" },
          matchers: { type: "array", items: { type: "string" } },
          productId: { type: "string", description: "ID del producto a vincular (preferido; de listar_productos)" },
          productName: { type: "string", description: "Alternativa: nombre del producto (match tolerante; \"\" desvincula)" },
          etiquetas: { type: "array", items: { type: "string" }, description: "Etiquetas a asignar al lead al llegar (nombres o ids); [] las quita" },
          tablero: { type: "string", description: "Tablero del CRM al que mover al lead (nombre o id); null quita" },
          columna: { type: "string", description: "Columna del tablero (nombre o id)" },
          eliminar: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_campanas",
      description: "Campañas de envío masivo con sus stats (enviados, fallidos, total, estado).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_campana",
      description:
        "Crea una campaña de envío masivo de WhatsApp EN BORRADOR (no envía nada). La audiencia se arma con filtros combinables (tagIds del CRM, funnelStatus NUEVO|INTERESADO|ESPERANDO_PAGO|PAGADO|ENTREGADO, adSourceId del catálogo de anuncios) y/o phones explícitos. sendConfig controla el ritmo anti-ban y es PARCIAL (lo que no mandes toma el default seguro: 45–90 s entre contactos, pausa 180–300 s cada 10, tope 60/día, horario 09:00–21:00): intervalSec/intervalMaxSec (RANGO aleatorio en segundos entre contactos), pauseEvery + pauseSec/pauseMaxSec (pausa larga cada N), dailyLimit (tope diario que cuenta TODAS las campañas del negocio; con 0 no hay tope), sendFrom/sendUntil (HH:mm; SIN horario el tope reanuda a MEDIANOCHE), excludeMuted (no molestar a quienes están en atención humana, default true). Antes de crear, usa previsualizar_audiencia_campana para saber cuántos contactos reales saldrán. PASOS (opcional, `pasos`): secuencia por contacto en orden: {tipo:'mensaje', mensajes:[...]} | {tipo:'esperar', segundos} | {tipo:'etiquetar', agregar:[nombres], quitar:[nombres]} | {tipo:'mover_crm', tablero, columna} | {tipo:'modo_humano', avisarDueno?}; si no mandas pasos, se usa un único paso de mensaje con `mensajes`. etiquetasContexto / quitarEtiquetasContexto (nombres) se aplican a cada contacto alcanzado. Devuelve el total de contactos y un resumen interpretado del plan de envío: MUÉSTRASELO al usuario. Flujo seguro: previsualizar_audiencia_campana → crear borrador → enviar_prueba_campana al número del dueño → confirmación explícita → iniciar_campana → ver_campana para el seguimiento. Llámala tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "mensajes", "audiencia"],
        properties: {
          name: { type: "string" },
          mensajes: {
            type: "array",
            description: "Secuencia a enviar a cada contacto (1-10). {nombre} se sustituye por el nombre del contacto.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", description: "text | image | video | audio | document" },
                text: { type: "string", description: "Texto del mensaje o caption de la multimedia" },
                mediaUrl: { type: "string", description: "URL de un adjunto de esta conversación o archivo ya subido" },
              },
            },
          },
          audiencia: {
            type: "object",
            additionalProperties: false,
            properties: {
              tagIds: { type: "array", items: { type: "string" }, description: "IDs de etiquetas del CRM (ver_crm)" },
              funnelStatus: { type: "string", description: "Etapa del embudo (ej. INTERESADO)" },
              adSourceId: { type: "string", description: "ID del anuncio de origen (catálogo de anuncios)" },
              phones: { type: "array", items: { type: "string" }, description: "Teléfonos explícitos a incluir" },
            },
          },
          sendConfig: {
            type: "object",
            additionalProperties: false,
            properties: {
              intervalSec: { type: "number" },
              intervalMaxSec: { type: "number" },
              pauseEvery: { type: "number" },
              pauseSec: { type: "number" },
              pauseMaxSec: { type: "number" },
              dailyLimit: { type: "number" },
              sendFrom: { type: "string", description: "HH:mm" },
              sendUntil: { type: "string", description: "HH:mm" },
              excludeMuted: { type: "boolean" },
            },
          },
          contextProductId: { type: "string", description: "Producto en foco: el agente sabrá de qué producto hablar cuando respondan" },
          contextTagIds: { type: "array", items: { type: "string" }, description: "Etiquetas (ids) a aplicar a cada contacto alcanzado" },
          etiquetasContexto: { type: "array", items: { type: "string" }, description: "Etiquetas (NOMBRES) a aplicar a cada contacto alcanzado" },
          quitarEtiquetasContexto: { type: "array", items: { type: "string" }, description: "Etiquetas (NOMBRES) a quitar a cada contacto alcanzado" },
          pasos: { type: "array", items: { type: "object" }, description: "Secuencia por contacto: mensaje | esperar | etiquetar | mover_crm | modo_humano (ver descripción)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_campana",
      description:
        "Modifica una campaña EN BORRADOR (las lanzadas solo admiten cambiar el nombre). `data` PARCIAL: {name?, pasos? (reemplaza la secuencia completa; mismo formato que crear_campana), audiencia? (mismos filtros; reemplaza la audiencia), sendConfig? (se fusiona), contextProductId?, etiquetasContexto?, quitarEtiquetasContexto? (nombres; reemplazan)}. Llámala tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["campaignId", "data"], properties: { campaignId: { type: "string" }, data: { type: "object" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "eliminar_campana",
      description: "Elimina una campaña (borrador, terminada o cancelada; una en curso primero se detiene). Irreversible: SOLO tras confirmación explícita con el nombre.",
      parameters: { type: "object", additionalProperties: false, required: ["campaignId"], properties: { campaignId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "aprobar_comprobante",
      description:
        "APRUEBA un comprobante de pago del chat (listar_comprobantes → id) y lo marca como venta: opcionalmente lo asocia a un producto (productId o nombre) y al teléfono del pagador. Dispara la entrega/flujo post-pago igual que el botón del panel. Irreversible: muestra monto, pagador y producto y pide confirmación explícita antes.",
      parameters: { type: "object", additionalProperties: false, required: ["receiptId"], properties: { receiptId: { type: "string" }, producto: { type: "string", description: "id o nombre del producto (opcional)" }, telefonoPagador: { type: "string", description: "teléfono del cliente (opcional)" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "rechazar_comprobante",
      description: "RECHAZA un comprobante pendiente del chat con un motivo (el cliente puede recibir aviso según el flujo). Llámala SOLO tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["receiptId", "motivo"], properties: { receiptId: { type: "string" }, motivo: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "ignorar_comprobante",
      description: "Marca un comprobante pendiente como IGNORADO (no es un pago real: captura repetida, prueba, spam). Llámala SOLO tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["receiptId"], properties: { receiptId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "asociar_comprobante",
      description: "Asocia un comprobante a un producto (id o nombre) y/o al teléfono del pagador sin cambiar su estado (para ordenar antes de aprobar).",
      parameters: { type: "object", additionalProperties: false, required: ["receiptId"], properties: { receiptId: { type: "string" }, producto: { type: "string" }, telefonoPagador: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "enviar_prueba_campana",
      description:
        "Envía la secuencia de una campaña EN BORRADOR a UN número de prueba (el del dueño), sin tocar la audiencia ni las stats. Recomiéndala SIEMPRE antes de iniciar_campana.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["campaignId", "phone"],
        properties: { campaignId: { type: "string" }, phone: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "iniciar_campana",
      description:
        "LANZA una campaña en borrador: comienza el envío masivo REAL e IRREVERSIBLE a toda la audiencia. Llámala ÚNICAMENTE después de mostrarle al usuario el total de contactos + el resumen del plan de envío Y de que él confirme explícitamente el lanzamiento. Ante la duda, NO la llames. Solo puede haber UNA campaña en curso por negocio (mismo número de WhatsApp): si otra está corriendo, devuelve error con su nombre.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["campaignId"],
        properties: { campaignId: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "previsualizar_audiencia_campana",
      description:
        "Cuenta cuántos contactos recibirían una campaña de WhatsApp con esa audiencia (misma forma que crear_campana.audiencia: tagIds, funnelStatus, adSourceId, phones) aplicando las MISMAS exclusiones del lanzamiento (no contactar, atención humana si excludeMuted, duplicados, números inválidos) y devuelve una muestra. Úsala ANTES de crear_campana para que el dueño sepa el total real. No escribe nada.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["audiencia"],
        properties: {
          audiencia: { type: "object", description: "{tagIds?, funnelStatus?, adSourceId?, phones?}" },
          excludeMuted: { type: "boolean", description: "default true (igual que la campaña)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_campana",
      description:
        "Detalle y SEGUIMIENTO de una campaña de WhatsApp (listar_campanas → id): estado, plan de envío interpretado, pasos en texto, ritmo (sendConfig), progreso (enviados/fallidos/pendientes), cuándo sale el próximo contacto y POR QUÉ espera (pausa entre lotes, tope diario, fuera de horario, pausada por fallos seguidos) y los últimos fallidos con su motivo. Úsala cuando el dueño pregunte cómo va, por qué está detenida o cuántos faltan.",
      parameters: { type: "object", additionalProperties: false, required: ["campaignId"], properties: { campaignId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "pausar_campana",
      description: "Pausa una campaña EN CURSO (deja de tomar contactos; lo enviado no se deshace). Reversible con reanudar_campana. Llámala cuando el dueño lo pida.",
      parameters: { type: "object", additionalProperties: false, required: ["campaignId"], properties: { campaignId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "reanudar_campana",
      description:
        "Continúa una campaña PAUSADA (manual o automática por fallos) desde donde quedó, con el mismo ritmo. Si se pausó por fallos seguidos, pide al dueño que confirme que su WhatsApp sigue conectado antes. Falla si otra campaña del negocio ya está en curso.",
      parameters: { type: "object", additionalProperties: false, required: ["campaignId"], properties: { campaignId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_campana",
      description:
        "CANCELA definitivamente una campaña en curso o pausada: los pendientes NO se enviarán y no se puede reanudar (lo ya enviado queda). Irreversible: SOLO tras confirmación explícita con el nombre de la campaña. Para una pausa temporal usa pausar_campana.",
      parameters: { type: "object", additionalProperties: false, required: ["campaignId"], properties: { campaignId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "gestionar_suscripcion",
      description:
        "SUSCRIPCIONES (rubro STREAMER): accion 'crear' {cliente (teléfono o id), producto (id o nombre), plan?, vence? (ISO) o duracionDias?, monto?, nota?} | 'renovar' {subscriptionId} (extiende según su plan y reprograma el aviso de vencimiento) | 'cancelar' {subscriptionId}. listar_suscripciones da los ids. Llámala tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["accion"], properties: { accion: { type: "string", description: "crear | renovar | cancelar" }, subscriptionId: { type: "string" }, cliente: { type: "string" }, producto: { type: "string" }, plan: { type: "string" }, vence: { type: "string" }, duracionDias: { type: "number" }, monto: { type: "string" }, nota: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_inventario_streaming",
      description: "INVENTARIO de cuentas/credenciales de streaming (rubro STREAMER): resumen por producto (disponibles/asignadas/caídas/deshabilitadas) y, con productId, la lista (sin contraseñas completas).",
      parameters: { type: "object", additionalProperties: false, properties: { productId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "actualizar_inventario_streaming",
      description:
        "Gestiona credenciales de streaming: accion 'agregar' {producto (id o nombre), items: [{email?, username?, password?, profileName?, pin?, optionLabel? (perfil/plan), note?}]} | 'editar' {credentialId, data: {mismos campos, status?: AVAILABLE|DOWN|DISABLED}} | 'eliminar' {credentialId}. Las contraseñas se guardan tal cual (el bot las entrega al vender). Llámala tras confirmación.",
      parameters: { type: "object", additionalProperties: false, required: ["accion"], properties: { accion: { type: "string" }, producto: { type: "string" }, items: { type: "array", items: { type: "object" } }, credentialId: { type: "string" }, data: { type: "object" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_reportes",
      description:
        "REPORTES programados del dashboard por correo/WhatsApp: sin `data` devuelve la config actual; con `data` PARCIAL {email?, waPhone?, dailyEnabled?, weeklyEnabled?, monthlyEnabled?, sendHour? (0-23)} la actualiza; con `prueba`: 'daily'|'weekly'|'monthly' envía uno de prueba ahora. Llámala tras confirmación cuando cambies algo.",
      parameters: { type: "object", additionalProperties: false, properties: { data: { type: "object" }, prueba: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_flujos",
      description: "Lista los FLUJOS de chatbot del negocio (id, nombre, activo, disparador en palabras, nº de bloques, link /flujos/<id>). Úsala cuando el dueño pregunte qué flujos tiene o antes de editar/activar uno. Para ver los bloques de uno usa ver_flujo; para crear o cambiar, ver_bloques_flujo → crear_flujo / editar_flujo.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_bloques_flujo",
      description:
        "LEE antes de diseñar o editar un flujo (siempre, aunque creas recordarlo): devuelve los BLOQUES disponibles (tipos, campos de data, salidas y QUÉ VE EL CLIENTE en cada uno), las reglas obligatorias del grafo, las facilidades de crear_flujo (nombres en vez de ids, posiciones e ids de opción automáticos), un EJEMPLO COMPLETO válido para copiar su forma, y los DATOS REALES del negocio (tableros y columnas del CRM, etiquetas, servicios con agenda, anuncios, otros flujos, modo del bot) con sus ids. Sin esto NO sabes qué bloques existen ni qué ids usar.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "ver_flujo",
      description: "Muestra un flujo existente {flowId (id o nombre)}: resumen legible bloque por bloque (con nombres de columnas/etiquetas y qué recibe el cliente en cada pregunta) y el JSON completo {trigger, nodes, edges}. Llámala SIEMPRE antes de editar_flujo y parte de ese JSON conservando ids (de nodos y de opciones) y posiciones de lo que no cambie.",
      parameters: { type: "object", additionalProperties: false, required: ["flowId"], properties: { flowId: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "crear_flujo",
      description:
        "CREA un flujo de chatbot completo {nombre*, descripcion?, trigger, nodes*, edges*, soloValidar?, activar?}. SECUENCIA: ver_bloques_flujo (y ver_crm si usa tablero/etiquetas) → proponer al dueño en lenguaje llano lo que recibirá el cliente → confirmación → crear_flujo soloValidar=true → crear_flujo. trigger = {onAnyMessage, keywords[], onFirstMessageOfDay, onFirstMessageEver, reactivationMinutes, onAdLead (lead que llega desde un anuncio de Meta), anuncios[] (descripciones o ids del catálogo; vacío = cualquier anuncio)}. nodes/edges siguen EXACTAMENTE los bloques, reglas y EJEMPLO de ver_bloques_flujo. Facilidades: position opcional (se ordena solo), ids de edge y de opciones opcionales, y referencias POR NOMBRE: crm-move {tablero, columna}; crm-add-tags/crm-remove-tags {etiquetas:[nombres]}; book-appointment/validate-payment {producto}; condition {etiqueta}; flow-control {flujo}. Bloque answers: el message es SOLO la pregunta; las opciones se muestran numeradas al cliente automáticamente y se aceptan por número o nombre — NO escribas la lista en el message ni crees opciones «1»,«2». El servidor valida todo (zod + grafo + que los ids existan + modo del bot) y devuelve errores concretos: corrígelos y vuelve a llamar. soloValidar=true comprueba y devuelve el resumen SIN guardar (úsalo antes de guardar). El flujo se guarda INACTIVO (link /flujos/<id> para revisarlo); activar=true lo enciende en la misma llamada SOLO si el usuario lo pidió explícitamente. Llámala tras confirmación del usuario.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["nombre", "nodes", "edges"],
        properties: {
          nombre: { type: "string", description: "Nombre único del flujo (máx 60)" },
          descripcion: { type: "string" },
          trigger: { type: "object", description: "Disparador {onAnyMessage, keywords[], onFirstMessageOfDay, onFirstMessageEver, reactivationMinutes, onAdLead (lead que llega desde un anuncio de Meta: su primer mensaje), anuncios[] (descripciones o ids del catálogo para restringir; vacío = cualquier anuncio)}" },
          nodes: { type: "array", items: { type: "object" }, description: "Nodos {id, type, data, position?} (ver ver_bloques_flujo)" },
          edges: { type: "array", items: { type: "object" }, description: "Aristas {id?, source, sourceHandle, target}" },
          soloValidar: { type: "boolean", description: "true = validar y resumir sin guardar" },
          activar: { type: "boolean", description: "true = activar tras crear (solo si el usuario lo pidió)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_flujo",
      description:
        "EDITA un flujo existente {flowId* (id o nombre), nombre?, descripcion?, trigger?, nodes?, edges?, soloValidar?}. Si mandas nodes/edges REEMPLAZAN el grafo COMPLETO (lo que no incluyas desaparece): primero ver_flujo, parte de su JSON y conserva ids de nodos, ids de opciones (los edges usan opt:<id>) y posiciones de lo que no cambie. Para simplificar un answers con opciones duplicadas («1» y «Página web» al mismo destino), deja una sola opción por rama con su nombre: el número ya se acepta solo. Mismas facilidades y validación que crear_flujo; usa soloValidar=true antes de guardar. Si el flujo estaba ACTIVO y queda con errores, se desactiva solo y se te informa. Sin nodes/edges solo cambia nombre/descripción/disparador. Llámala tras confirmación del usuario.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["flowId"],
        properties: {
          flowId: { type: "string" },
          nombre: { type: "string" },
          descripcion: { type: "string" },
          trigger: { type: "object" },
          nodes: { type: "array", items: { type: "object" } },
          edges: { type: "array", items: { type: "object" } },
          soloValidar: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activar_flujo",
      description: "Activa o desactiva un flujo de chatbot {flowId (id o nombre), activo}. Al activar se valida con el modo actual del bot (to-agent solo en HYBRID): si tiene errores NO se activa y se devuelven para corregirlos con editar_flujo. Recuerda: los flujos solo corren con el bot en modo FLOW o HYBRID (configurar_empresa botMode); en FLOW el bot calla si ningún flujo se dispara, en HYBRID responde el agente IA. Avisa al dueño si el flujo tiene disparador onAnyMessage/onAdLead porque empezará a responder a leads reales de inmediato. Llámala tras confirmación explícita.",
      parameters: { type: "object", additionalProperties: false, required: ["flowId", "activo"], properties: { flowId: { type: "string" }, activo: { type: "boolean" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "configurar_pixel_tienda",
      description: "Enciende o apaga el PÍXEL de Meta en la tienda web {activo}. Requiere que Meta CAPI ya esté configurado en Integraciones (token y Dataset ID se gestionan SOLO desde el panel). Sin `activo` devuelve el estado.",
      parameters: { type: "object", additionalProperties: false, properties: { activo: { type: "boolean" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_suscripciones",
      description: "Suscripciones de streaming: filtro 'active' (vigentes), 'due' (por vencer en 7 días) o 'expired' (vencidas).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { filtro: { type: "string", description: "active | due | expired" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_recordatorios_programados",
      description:
        "Recordatorios (seguimientos, citas, renovaciones) con fecha y cliente. Por defecto los PENDIENTES: devuelve el TOTAL real, cuántos van ATRASADOS (más de 1 h) y por tipo, y cada ítem con su id, paso de la secuencia y atrasoMin (minutos desde su hora planificada) — los ids sirven para cancelar_recordatorios; filtra con phone, tipo, productId o atrasadosMasDeHoras. Con estado=SENT devuelve los ENVIADOS en un rango (desde/hasta ISO) más un RESUMEN para analizar ráfagas: envíos por hora, separación mínima/promedio entre envíos consecutivos y por tipo — úsalo para verificar que los recordatorios de la apertura (p. ej. 7am) salieron dispersos y espaciados. estado=FAILED o CANCELLED muestra el motivo; en CANCELLED, «colapsado…» o «venció…» es la COLA descartando pasos viejos a propósito (no es un fallo): cuando varios pasos de un cliente están vencidos sale solo el más reciente.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number", description: "máx 100 (default 50)" },
          estado: { type: "string", enum: ["PENDING", "SENT", "FAILED", "CANCELLED"], description: "default PENDING" },
          desde: { type: "string", description: "ISO (solo con estado≠PENDING); default: últimas 24 h" },
          hasta: { type: "string", description: "ISO (solo con estado≠PENDING)" },
          phone: { type: "string", description: "solo PENDING: teléfono o id del cliente" },
          tipo: { type: "string", enum: LISTABLE_TYPES, description: "solo PENDING: filtrar por tipo" },
          productId: { type: "string", description: "solo PENDING: uuid del producto" },
          atrasadosMasDeHoras: { type: "number", description: "solo PENDING: solo los que llevan más de N horas de atraso respecto a su hora planificada" },
          soloAtrasados: { type: "boolean", description: "solo PENDING: solo los que llevan más de 1 h de atraso (lo mismo que cuenta 'atrasados')" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_recordatorio",
      description:
        "EDITA el contenido de UN recordatorio PENDIENTE (id de listar_recordatorios_programados): el texto (mensaje), la multimedia (mediaUrl http(s) de imagen/video/audio/PDF, o quitarMultimedia=true para dejarlo solo texto) y/o la hora de envío (enviarEn ISO futuro; también mueve su hora planificada). Parcial: envía solo lo que cambia; el texto reemplaza al anterior completo (pide/escribe la versión final; admite variantes {Hola|Buenas}; el nombre del cliente ya está reemplazado, escríbelo literal si lo quieres). AVISO para carrito/visto: si el cliente vuelve a escribir, el bot recrea la secuencia y el cambio se pierde (los manuales se conservan). Para cambiar MUCHOS recordatorios a la vez no edites uno por uno: cambia la secuencia (configurar_recordatorios o reminderConfig del producto) — eso aplica a los que se programen desde ahora. Llámala SOLO tras confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", description: "id del recordatorio pendiente" },
          mensaje: { type: "string", description: "texto final completo" },
          mediaUrl: { type: "string", description: "URL http(s) de la multimedia (archivo de producto, recurso de listar_recursos o adjunto)" },
          mediaType: { type: "string", enum: ["image", "video", "audio", "pdf", "document"], description: "tipo del adjunto (default según extensión)" },
          quitarMultimedia: { type: "boolean", description: "true = quita la multimedia actual" },
          enviarEn: { type: "string", description: "nueva fecha-hora ISO futura (ej. 2026-11-02T18:30:00-05:00)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancelar_recordatorios",
      description:
        "CANCELA recordatorios PENDIENTES (no se envían). Individual o selección: ids (de listar_recordatorios_programados). En lote: filtro {phone?, tipo?, productId?, atrasadosMasDeHoras?} (al menos un campo; no existe 'cancelar todos' sin filtro). Sin tipo, el filtro solo toca SEGUIMIENTOS (carrito, visto, cuenta regresiva, post-venta, manuales); citas (BOOKING_REMINDER) y renovaciones (RENEWAL) solo si se nombran en tipo o por id. FLUJO OBLIGATORIO en lote: primero soloContar=true, muéstrale al dueño cuántos y la muestra, y cancela SOLO tras su confirmación explícita; por id, también tras confirmación. Es IRREVERSIBLE (quedan CANCELLED con motivo 'Cancelado por el dueño'); si el cliente vuelve a escribir, el bot programa su secuencia de nuevo, y uno puntual se repone con programar_recordatorio_cliente.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "ids de recordatorios (1-500)" },
          filtro: {
            type: "object",
            additionalProperties: false,
            properties: {
              phone: { type: "string", description: "teléfono o id del cliente: todos sus pendientes" },
              tipo: { type: "string", enum: LISTABLE_TYPES },
              productId: { type: "string", description: "uuid del producto" },
              atrasadosMasDeHoras: { type: "number", description: "solo los que llevan más de N horas de atraso" },
            },
          },
          soloContar: { type: "boolean", description: "true = solo cuenta y muestra 5 de ejemplo, no cancela" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_recursos",
      description:
        "BIBLIOTECA DE RECURSOS: lista TODA la multimedia reutilizable del negocio con su URL — archivos de los productos (ver_producto → files) MÁS la multimedia que vive en recordatorios (generales y por producto), banner y mensajes adicionales de presentación, mensajes post-venta y enganche. Cada ítem trae tipo (IMAGE/VIDEO/AUDIO/PDF/OTHER), origen, en qué producto está, su descripción/mensaje y en qué otros lugares se usa (tambienEn). Úsala para REUTILIZAR algo ya subido (p. ej. 'usa el video del recordatorio en la campaña') en crear_campana, respuestas rápidas, recordatorios, presentación o tienda sin volver a subirlo. Es la misma lista que ve el dueño en la pestaña Recursos del chat, en 'Insertar recurso' de campañas y en los recursos de muestra de la tienda. Los marcados privado=true van con enlace firmado y NO sirven para campañas ni tienda. Solo lectura.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          productId: { type: "string", description: "uuid del producto para ver solo sus recursos (los recordatorios generales no tienen producto)" },
          tipo: { type: "string", enum: ["IMAGE", "VIDEO", "AUDIO", "PDF", "OTHER"], description: "filtrar por tipo" },
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
const EMAIL_DELIVERY_FIELDS =
  "emailEnabled (true = entrega por CORREO a pedido del cliente: cuando un cliente que ya pagó pide el acceso por email, el agente se lo envía con el mensaje de entrega + los followupMessages y su multimedia, igual que por WhatsApp), emailSubject? y emailBody? (opcionales; por defecto 'Tu acceso a {producto} — {negocio}' y el mismo mensaje de entrega; emailBody reemplaza SOLO el mensaje principal)";

const COMMON_FIELDS =
  "Campos comunes de `data`: name*, price* (texto, ej. '12' o '12.50', SIN símbolo — está en la MONEDA del negocio, ver_configuracion la muestra), shortDescription (1 línea vendedora), fullDescription, category, active (default true), aliases (string[] — sinónimos/abreviaturas con las que el cliente lo nombraría), benefits (string[]), includes (string[]), bonuses (string[]), faqs ([{question, answer}]), objections ([{question, answer}]), attributes (objeto clave→valor, ej. {\"Ingredientes\": \"pollo, papas\"}). " +
  "reminderConfig (recordatorios PROPIOS de este producto — si no se envía, hereda los generales del negocio): {abandonedCart?: {enabled, steps: [{delaySeconds (SEGUNDOS, ej. 3600=1h, 86400=24h), message, offerPrice? (OFERTA ESCALONADA: al enviarse ese paso, el agente ofrece/cobra/valida ese precio SOLO a ese cliente; usa {oferta} en el mensaje para mostrarlo)}]}, leftOnRead?: {enabled, steps: [...]}}; enviar null lo limpia (vuelve a heredar). " +
  "OFERTA CON VIGENCIA (global, todos los clientes): offerPrice (texto, ej. '49'), offerStartsAt/offerEndsAt (fecha-hora ISO, opcionales; sin fechas = activa hasta quitarla). Vigente => el agente presenta, cobra y valida ESE precio y el precio normal se muestra tachado como 'antes'. null limpia la oferta. " +
  "ENTREGA POR CORREO (a pedido del cliente): se activa POR PRODUCTO con digitalDelivery.emailEnabled=true. Con eso, cuando un cliente que YA PAGÓ pide recibir el acceso por email, el agente le pide el correo, se lo envía (el correo sale desde la dirección de FlowApp con el nombre del negocio como remitente) y guarda el correo en su ficha; la entrega por WhatsApp sigue igual. El correo replica la entrega de WhatsApp: mensaje de entrega + mensajes adicionales (followupMessages) con su multimedia adjunta. emailSubject/emailBody son opcionales (por defecto el asunto es 'Tu acceso a {producto} — {negocio}' y el cuerpo es el mismo mensaje de entrega; emailBody reemplaza solo el mensaje principal, los adicionales se agregan igual). Los archivos del producto se adjuntan ADEMÁS con configurar_archivo_producto adjuntarEnCorreo=true (tope 15 MB entre todos los adjuntos; lo que excede va como link). El servidor de correo es de la plataforma: NO se configura desde el panel ni desde aquí. Si el dueño pide activarlo 'en todos los productos', hazlo producto por producto con actualizar_producto tras UNA confirmación. Detección: basta con que el cliente ESCRIBA su correo (solo o junto al comprobante, ej. 'Enviar a: juan@gmail.com'); el sistema lo guarda como correo pendiente y envía el acceso al aprobar el pago, incluso si la aprobación fue en 2º plano (recheck o Mercado Pago). " +
  "INVITACIÓN A LA TIENDA (por producto): digitalDelivery.storeInviteEnabled=true hace que el ÚLTIMO mensaje de la entrega por WhatsApp sea una invitación a visitar la tienda web con su link (storeInviteText opcional, admite {tienda} para el link y spintax; vacío = '🛍️ Tenemos más productos que te pueden interesar. Visita nuestra tienda: {tienda}'). Si está activa REEMPLAZA al cross-sell y a la frase genérica del catálogo (un solo cierre). Solo se envía si la tienda está publicada (ver_tienda → lista); si no, el cierre es el de siempre. Si el dueño pide activarla 'en todos los productos', hazlo producto por producto con actualizar_producto tras UNA confirmación. " +
  "PRESENTACIÓN: presentationMessage (mensaje de presentación FIJO — si existe, la ficha se envía tal cual en vez de auto-generarse); presentationMessageMediaUrl/presentationMessageMediaType (banner adjunto al mensaje: la ficha viaja como media con el texto de caption; usa la URL de un archivo del producto o un adjunto de esta conversación; '' lo quita); presentationFollowups = [{message, mediaUrl?, mediaType?}] (secuencia que se envía DESPUÉS de la ficha — al enviarla REEMPLAZA la lista completa: manda la versión final; [] la limpia). Los archivos ya subidos se gestionan con configurar_archivo_producto (showInPresentation true = va adjunto en la presentación, false = on-demand; description; principal). SPINTAX ANTI-BLOQUEO: presentationMessage, presentationFollowups, la description de los archivos (va como caption), digitalDelivery.instructions/followupMessages/crossSellPitch/storeInviteText y los mensajes de recordatorios/campañas admiten variantes {Hola|Buenas|Qué tal} — cada cliente recibe una combinación distinta y así la ficha no llega idéntica a todos; recomiéndalo (3 o más variantes en saludo, verbo y cierre; nunca en precios ni links). La ficha AUTOMÁTICA (sin presentationMessage) no admite variantes en sus títulos. Tras cambiar la presentación, VERIFICA con previsualizar_ficha (muestra UNA variante).";

function rubroGuide(vertical: string | undefined): string {
  switch (vertical) {
    case "RESTAURANT":
      return `Rubro RESTAURANTE (cada producto = un plato/bebida). ${COMMON_FIELDS} Además: category = SECCIÓN del menú (Entradas, Principales, Bebidas...); verticalData.modifierGroups = [{name, required (bool), options: [{label, priceDelta (número, 0 si no cambia el precio)}]}] para tamaños/extras (ej. Tamaño* Personal:0/Familiar:8); attributes con Ingredientes y "Tiempo de preparación".`;
    case "PHYSICAL_GOODS":
      return `Rubro COMERCIAL (productos físicos: ropa, ferretería, licorería...). ${COMMON_FIELDS} Además: stock (número, si controla inventario); variants = [{name, options: string[], sortOrder}] para Talla/Color (las opciones NO cambian el precio); physicalDelivery = {requiresAddress: true, deliveryCost?, deliveryTime?, pickupAvailable, deliveryAreas: string[]} (zonas de entrega — pregunta las zonas si va a crear el primero).`;
    case "SERVICE":
      return `Rubro SERVICIOS (cada producto = un servicio, con cita opcional). ${COMMON_FIELDS} Además: durationMin (minutos de la cita — con esto el agente agenda con horarios reales), slotCapacity (citas simultáneas, default 1), bookingLeadMinutes, bookingHorizonDays; verticalData.modality ('presencial'|'online'|'ambas') y verticalData.meetingUrl (enlace FIJO de videollamada Meet/Zoom de ESTE servicio; si falta se usa el del negocio, configurar_empresa meetingUrl); deliveryMethod/support como texto libre si aplica. Para captar LEADS de servicios sin venta directa (desarrollo, consultoría, proyectos), lo habitual es un flujo de calificación (ver_bloques_flujo → crear_flujo) con preguntas answers de opciones numeradas (una opción por servicio o rango, sin opciones «1»,«2» aparte), etiquetas y columnas del CRM y derivación a humano con aviso por WhatsApp; si los leads vienen de Meta Ads, el anuncio del catálogo pone la etiqueta de origen y la columna de entrada (configurar_anuncio) y el flujo se dispara con onAdLead. Si quiere que tras calificar el AGENTE converse (dudas, agendar la llamada), recomienda botMode HYBRID: el flujo termina en to-agent y el catálogo debe tener un servicio por línea de negocio (precio como texto 'desde…' o 'según cotización', FAQs y objeciones) más un servicio 'Llamada de diagnóstico' con durationMin para agendar. AGENDA DEL AGENTE: consulta los huecos reales por día y franja (fecha/horaDesde/horaHasta), ve el horario de atención (configurar_empresa businessHours) y recuerda los horarios que ofreció para agendar directo cuando el cliente elige; si el dueño reporta 'dijo que no había horarios' revisa con leer_conversacion, el horario de atención, los bloqueos y durationMin del servicio. Si quiere que el agente mueva el tablero solo, configurar_agente crmTool con lista blanca: «Reunión agendada» (cuando la cita quedó confirmada), «Propuesta enviada» (cuando pide la propuesta por escrito), «Perdido / En pausa» (cuando dice que no le interesa) y etiqueta «🔥 Caliente» (pide precio, fecha o propuesta), cada una con su 'cuando'.`;
    case "REAL_ESTATE":
      return `Rubro INMOBILIARIA (cada producto = un inmueble). ${COMMON_FIELDS} Además: verticalData con la ficha: {operation ('venta'|'alquiler'), propertyType, areaM2, bedrooms, bathrooms, parking, location, maintenance, antiquity}; durationMin para la duración de la visita (agenda).`;
    case "STREAMER":
      return `Rubro STREAMING (cada producto = una plataforma/cuenta). ${COMMON_FIELDS} Además: category = plataforma (Netflix, Disney...); verticalData.plans = [{label, price}] para modalidades (mensual/anual, pantallas) y verticalData.durationDays (duración de la suscripción en días); digitalDelivery = {instructions (mensaje de entrega con el acceso), assignmentMode, followupMessages: [{message, mediaUrl?}] (mensajes POST-VENTA que se envían inmediatamente tras entregar), ${EMAIL_DELIVERY_FIELDS} (solo aplica en assignmentMode STATIC)}; RENOVACIÓN: reminderConfig.renewal = {enabled, daysBefore, message} (aviso al cliente N días antes del vencimiento).`;
    case "INFOPRODUCT":
      return `Rubro INFOPRODUCTOS (cursos, ebooks, accesos). ${COMMON_FIELDS} Además: digitalDelivery = {instructions* (mensaje de entrega que incluye el link de acceso), link, followupMessages: [{message, mediaUrl?}] (mensajes POST-VENTA que se envían inmediatamente tras entregar: agradecimiento, bonus, instrucciones extra), ${EMAIL_DELIVERY_FIELDS}, storeInviteEnabled?, storeInviteText?}; benefits/faqs/objections completos son CLAVE para que el agente venda bien.`;
    default:
      return `Rubro OTRO/general. ${COMMON_FIELDS} productType puede ser 'DIGITAL' o 'PHYSICAL'; si es físico agrega physicalDelivery; si es digital, digitalDelivery = {instructions* (mensaje de entrega con el link), followupMessages, ${EMAIL_DELIVERY_FIELDS}, storeInviteEnabled?, storeInviteText?}.`;
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
/**
 * crmTool por NOMBRES (copiloto/MCP) → crmToolConfig por ids, validado con el
 * mismo zod del panel (cada columna/etiqueta permitida exige su regla "cuando").
 */
async function resolveCrmToolConfig(companyId: string, raw: unknown): Promise<Record<string, unknown> | null> {
  if (raw === null || raw === false) return null;
  const r = (raw && typeof raw === "object" ? raw : {}) as LooseData;
  const { boards, tags } = await listCrmStructure(companyId);
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const boardRef = asStr(r.tablero) ?? asStr(r.crmId);
  const board = boardRef ? boards.find((b) => b.id === boardRef || norm(b.name) === norm(boardRef)) : boards.length === 1 ? boards[0] : undefined;
  if (r.enabled !== false && !board) throw new AppError(`Indica el tablero (ver_crm lista: ${boards.map((b) => `«${b.name}»`).join(", ") || "ninguno"})`, 400);
  const columns = (Array.isArray(r.columnas) ? r.columnas : []).map((c) => {
    const o = (c && typeof c === "object" ? c : { columna: c }) as LooseData;
    const ref = asStr(o.columna) ?? asStr(o.columnId) ?? "";
    const col = board?.columns.find((x) => x.id === ref || norm(x.name) === norm(ref));
    if (!col) throw new AppError(`La columna «${ref}» no existe en el tablero «${board?.name ?? "?"}» (ver_crm)`, 400);
    return { columnId: col.id, when: String(o.cuando ?? o.when ?? "").trim() };
  });
  const addTags = (Array.isArray(r.etiquetas) ? r.etiquetas : []).map((t) => {
    const o = (t && typeof t === "object" ? t : { etiqueta: t }) as LooseData;
    const ref = asStr(o.etiqueta) ?? asStr(o.tagId) ?? "";
    const tag = tags.find((x) => x.id === ref || norm(x.name) === norm(ref));
    if (!tag) throw new AppError(`La etiqueta «${ref}» no existe (créala con crear_etiqueta)`, 400);
    return { tagId: tag.id, when: String(o.cuando ?? o.when ?? "").trim() };
  });
  const removeTagIds = (asStrList(r.quitarEtiquetas) ?? []).map((ref) => {
    const tag = tags.find((x) => x.id === ref || norm(x.name) === norm(ref));
    if (!tag) throw new AppError(`La etiqueta «${ref}» no existe (créala con crear_etiqueta)`, 400);
    return tag.id;
  });
  const candidate = {
    enabled: r.enabled !== false,
    crmId: board?.id ?? null,
    columns,
    addTags,
    removeTagIds,
    onlyForward: typeof r.soloAvanzar === "boolean" ? r.soloAvanzar : true,
    maxPerTurn: Number(r.maxPorTurno) || 1,
    notifyOwner: typeof r.avisarDueno === "boolean" ? r.avisarDueno : true,
  };
  const parsed = crmToolConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => {
      const path = i.path.join(".");
      const idx = typeof i.path[1] === "number" ? i.path[1] : -1;
      const who = i.path[0] === "columns" && idx >= 0 ? `columna «${board?.columns.find((c) => c.id === columns[idx]?.columnId)?.name ?? "?"}»` : i.path[0] === "addTags" && idx >= 0 ? `etiqueta «${tags.find((t) => t.id === addTags[idx]?.tagId)?.name ?? "?"}»` : path;
      return `${who}: ${i.message}`;
    });
    throw new AppError(`Configuración de la herramienta de CRM inválida — ${msgs.join("; ")}. Cada columna/etiqueta permitida necesita su regla "cuando".`, 400);
  }
  return parsed.data as unknown as Record<string, unknown>;
}

/** crmToolConfig (ids) → vista con nombres para ver_configuracion. */
async function describeCrmToolConfig(companyId: string, raw: unknown) {
  const cfg = raw && typeof raw === "object" ? (raw as LooseData) : null;
  if (!cfg) return { activa: false, nota: "Apagada: el agente no mueve ni etiqueta en el CRM por su cuenta (configurar_agente crmTool)." };
  const { boards, tags } = await listCrmStructure(companyId);
  const board = boards.find((b) => b.id === cfg.crmId);
  const colName = (id: unknown) => board?.columns.find((c) => c.id === id)?.name ?? "(eliminada)";
  const tagName = (id: unknown) => tags.find((t) => t.id === id)?.name ?? "(eliminada)";
  return {
    activa: cfg.enabled === true,
    tablero: board?.name ?? "(eliminado)",
    columnas: (Array.isArray(cfg.columns) ? cfg.columns : []).map((c) => ({ columna: colName((c as LooseData).columnId), cuando: (c as LooseData).when })),
    etiquetas: (Array.isArray(cfg.addTags) ? cfg.addTags : []).map((t) => ({ etiqueta: tagName((t as LooseData).tagId), cuando: (t as LooseData).when })),
    quitarEtiquetas: (Array.isArray(cfg.removeTagIds) ? cfg.removeTagIds : []).map(tagName),
    soloAvanzar: cfg.onlyForward !== false,
    maxPorTurno: Number(cfg.maxPerTurn) || 1,
    avisarDueno: cfg.notifyOwner !== false,
  };
}

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
    // Banner del mensaje de presentación (la ficha viaja como media+caption). "" limpia.
    presentationMessageMediaUrl:
      data.presentationMessageMediaUrl !== undefined
        ? asStr(data.presentationMessageMediaUrl) ?? ""
        : (e?.presentationMessageMediaUrl ?? ""),
    presentationMessageMediaType:
      data.presentationMessageMediaType !== undefined
        ? asStr(data.presentationMessageMediaType) ?? ""
        : (e?.presentationMessageMediaType ?? ""),
    // Seguimientos de presentación (secuencia post-ficha): al venir REEMPLAZA la
    // lista completa (el modelo envía la versión final); null/[] la limpia.
    presentationFollowups: (() => {
      if (data.presentationFollowups === undefined) {
        return (e?.presentationFollowups ?? []) as { message?: string; mediaUrl?: string; mediaType?: string }[];
      }
      const inc = Array.isArray(data.presentationFollowups) ? data.presentationFollowups : [];
      return inc
        .map((m) => {
          const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
          return {
            message: asStr(o.message) ?? "",
            mediaUrl: asStr(o.mediaUrl) ?? "",
            mediaType: asStr(o.mediaType) ?? "",
          };
        })
        .filter((m) => m.message || m.mediaUrl);
    })(),
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
/**
 * Resuelve una URL de NUESTROS uploads (ej. imagen creada con generar_imagen) a
 * un adjunto utilizable como foto de producto. Anti path-traversal: el path
 * resuelto debe quedar DENTRO del UPLOAD_DIR. Devuelve null si no es nuestra o
 * no existe en disco.
 */
async function resolveOwnUploadImage(url: string): Promise<CopilotAttachment | null> {
  const rel = storagePathFromUrl(url);
  if (!rel) return null;
  const resolved = await resolveOwnUpload(rel);
  if (!resolved) return null;
  const extension = resolved.extension || "png";
  const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
  if (!IMAGE_EXTS.has(extension)) return null;
  return {
    url,
    storagePath: resolved.storagePath,
    originalName: resolved.fileName,
    extension,
    mimeType: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
    size: resolved.size,
    type: "IMAGE",
  };
}

/** Duración humana a partir de segundos (para el resumen del plan de envío). */
function fmtDurHuman(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** ¿Algún mensaje de texto de la campaña usa spintax {a|b|c}? (variantes anti-ban) */
function campaignHasSpintax(actions: CampaignAction[]): boolean {
  const re = /\{[^{}]*\|[^{}]*\}/;
  return actions.some((a) => a.type === "send-message" && a.messages.some((m) => re.test(m.text ?? "")));
}

/** Resumen interpretado del plan de envío (mismo espíritu que el wizard del panel) + avisos anti-ban. */
function describeSendPlan(cfg: CampaignSendConfig, total: number, actions?: CampaignAction[]): string {
  const avgInterval = cfg.intervalMaxSec > cfg.intervalSec ? (cfg.intervalSec + cfg.intervalMaxSec) / 2 : cfg.intervalSec;
  const avgPause = cfg.pauseMaxSec > cfg.pauseSec ? (cfg.pauseSec + cfg.pauseMaxSec) / 2 : cfg.pauseSec;
  const durationFor = (count: number) => {
    if (count <= 1) return 0;
    const pauses = cfg.pauseEvery > 0 ? Math.floor((count - 1) / cfg.pauseEvery) : 0;
    return (count - 1 - pauses) * avgInterval + pauses * avgPause;
  };
  const parts: string[] = [];
  parts.push(
    cfg.intervalMaxSec > cfg.intervalSec
      ? `Cada contacto sale entre ${cfg.intervalSec} y ${cfg.intervalMaxSec} s después del anterior (aleatorio).`
      : `Cada contacto sale exactamente cada ${cfg.intervalSec} s${cfg.randomize ? " (±25% aleatorio)" : " ⚠️ tiempos exactos = patrón detectable; recomienda un rango"}.`,
  );
  if (cfg.pauseEvery > 0) {
    parts.push(
      cfg.pauseMaxSec > cfg.pauseSec
        ? `Cada ${cfg.pauseEvery} contactos hay una pausa de ${cfg.pauseSec}–${cfg.pauseMaxSec} s.`
        : `Cada ${cfg.pauseEvery} contactos hay una pausa de ${cfg.pauseSec} s.`,
    );
  }
  const day1 = cfg.dailyLimit > 0 ? Math.min(cfg.dailyLimit, total) : total;
  parts.push(`Hoy salen ${day1} contacto(s) en ~${fmtDurHuman(durationFor(day1))}.`);
  const rest = total - day1;
  if (rest > 0) {
    const days = Math.ceil(rest / (cfg.dailyLimit || rest));
    parts.push(
      cfg.sendFrom
        ? `Los ${rest} restantes continúan al día siguiente desde las ${cfg.sendFrom} (${days} día(s) más).`
        : `⚠️ Los ${rest} restantes continúan a la MEDIANOCHE (sin "enviar desde" el tope diario reanuda a las 00:00) — recomienda configurar sendFrom/sendUntil.`,
    );
  }
  if (cfg.sendFrom && cfg.sendUntil) parts.push(`Horario de envío: ${cfg.sendFrom}–${cfg.sendUntil}.`);
  if (!cfg.excludeMuted) parts.push("⚠️ excludeMuted apagado: también recibirán la campaña los contactos en atención humana.");
  if (avgInterval < 30) parts.push(`⚠️ Intervalo medio de ${Math.round(avgInterval)} s: muy rápido para un número normal (riesgo de bloqueo); recomienda 45–120 s.`);
  if (cfg.dailyLimit <= 0 && total > 60) parts.push("⚠️ Sin tope diario: saldrían todos el mismo día; en números nuevos recomienda 30–60/día.");
  if (actions && actions.some((a) => a.type === "send-message") && !campaignHasSpintax(actions)) {
    parts.push("⚠️ Ningún mensaje usa variantes {Hola|Buenas|Qué tal}: todos recibirán el MISMO texto (patrón de spam); recomienda ≥3 variantes en saludo, verbo y cierre.");
  }
  parts.push(`Si ${AUTO_PAUSE_AFTER_FAILURES} envíos seguidos fallan, la campaña se pausa sola y avisa al dueño.`);
  return parts.join(" ");
}

/** Motivo de espera/pausa de una campaña en palabras para el dueño. */
function describePauseReason(status: string, reason: string | null, nextSendAt: Date | null): string | null {
  const when = nextSendAt ? ` (próximo contacto: ${nextSendAt.toLocaleString("es-PE", { timeZone: "America/Lima" })})` : "";
  if (status === "PAUSED") {
    return reason === "failures"
      ? `Pausada AUTOMÁTICAMENTE: ${AUTO_PAUSE_AFTER_FAILURES} envíos seguidos fallaron (revisar la conexión de WhatsApp antes de reanudar_campana)`
      : "Pausada manualmente (reanudar_campana para continuar)";
  }
  if (status !== "RUNNING") return null;
  switch (reason) {
    case "auto": return `Pausa automática entre lotes${when}`;
    case "daily-limit": return `Tope diario alcanzado${when}`;
    case "schedule": return `Fuera del horario de envío${when}`;
    default: return nextSendAt ? `Enviando${when}` : "Enviando";
  }
}

/** Pasos de una campaña en texto (ids de etiquetas/columnas → nombres). */
async function describeCampaignSteps(companyId: string, actions: CampaignAction[]): Promise<string[]> {
  const [tags, columns] = await Promise.all([
    prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crmColumn.findMany({ where: { crm: { companyId } }, select: { id: true, name: true, crm: { select: { name: true } } } }),
  ]);
  const tagName = (id: string) => tags.find((t) => t.id === id)?.name ?? "(eliminada)";
  return actions.map((a, i) => {
    const n = `${i + 1}) `;
    if (a.type === "send-message") {
      const msgs = a.messages.map((m) => (m.type === "text" ? `«${(m.text ?? "").slice(0, 160)}${(m.text ?? "").length > 160 ? "…" : ""}»` : `[${m.type}]${m.text ? ` «${m.text.slice(0, 80)}»` : ""}`));
      return `${n}Mensaje: ${msgs.join(" + ")}`;
    }
    if (a.type === "wait") return `${n}Esperar ${a.seconds} s`;
    if (a.type === "tag") {
      const add = (a.addTagIds ?? []).map(tagName);
      const rem = (a.removeTagIds ?? []).map(tagName);
      return `${n}Etiquetar${add.length ? ` +${add.join(", ")}` : ""}${rem.length ? ` −${rem.join(", ")}` : ""}`;
    }
    if (a.type === "crm-move") {
      const c = columns.find((x) => x.id === a.columnId);
      return `${n}Mover al CRM: ${c ? `${c.crm.name} → ${c.name}` : "(columna eliminada)"}`;
    }
    if (a.type === "handoff") return `${n}Pasar a atención humana${a.notifyOwner ? " y avisar al dueño" : ""}`;
    return `${n}${(a as { type: string }).type}`;
  });
}

/** Audiencia de campaña por filtros combinables (tags/etapa/anuncio) y/o phones explícitos. */
async function resolveCampaignAudience(
  companyId: string,
  a: { tagIds?: unknown; funnelStatus?: unknown; adSourceId?: unknown; phones?: unknown },
): Promise<Array<{ customerId?: string | null; phone: string; name?: string | null }>> {
  const out = new Map<string, { customerId?: string | null; phone: string; name?: string | null }>();
  const tagIds = Array.isArray(a.tagIds) ? a.tagIds.map((t) => String(t)).filter(Boolean) : [];
  const funnelStatus = asStr(a.funnelStatus)?.trim().toUpperCase() || null;
  const adSourceId = asStr(a.adSourceId)?.trim() || null;
  if (tagIds.length || funnelStatus || adSourceId) {
    const customerWhere = {
      companyId,
      NOT: { phone: { startsWith: "web:" } },
      ...(adSourceId ? { adSourceId } : {}),
      ...(tagIds.length ? { tagLinks: { some: { tagId: { in: tagIds } } } } : {}),
    };
    if (funnelStatus) {
      // La etapa vive en Conversation.state.status (JSON) → se filtra en memoria.
      const convos = await prisma.conversation.findMany({
        where: { companyId, channel: "whatsapp", customer: customerWhere },
        select: { state: true, customer: { select: { id: true, phone: true, name: true } } },
        take: 5000,
      });
      for (const c of convos) {
        const status = String((c.state as Record<string, unknown> | null)?.status ?? "").toUpperCase();
        if (status === funnelStatus) {
          out.set(c.customer.phone, { customerId: c.customer.id, phone: c.customer.phone, name: c.customer.name });
        }
      }
    } else {
      const customers = await prisma.customer.findMany({
        where: customerWhere,
        select: { id: true, phone: true, name: true },
        orderBy: { lastInteractionAt: "desc" },
        take: 5000,
      });
      for (const c of customers) out.set(c.phone, { customerId: c.id, phone: c.phone, name: c.name });
    }
  }
  for (const p of Array.isArray(a.phones) ? a.phones : []) {
    const d = String(p ?? "").replace(/\D/g, "");
    if (d.length >= 8 && !out.has(d)) out.set(d, { phone: d });
  }
  return [...out.values()];
}

/** Resuelve una categoría de respuestas rápidas por NOMBRE (case-insensitive), creándola si no existe. */
/** Pasos de campaña por NOMBRES → CampaignAction[] (mensaje | esperar | etiquetar | mover_crm | modo_humano). */
async function resolveCampaignSteps(companyId: string, pasos: unknown[], fallbackMessages: CampaignMessageItem[]): Promise<CampaignAction[]> {
  const [tags, boards, columns] = await Promise.all([
    prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crm.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crmColumn.findMany({ where: { crm: { companyId } }, select: { id: true, name: true, crmId: true } }),
  ]);
  const norm = (v: string) => v.trim().toLowerCase();
  const tagIds = (names: unknown) => (asStrList(names) ?? []).map((n) => {
    const t = tags.find((x) => x.id === n || norm(x.name) === norm(n));
    if (!t) throw new AppError(`La etiqueta «${n}» no existe (créala con crear_etiqueta)`, 400);
    return t.id;
  });
  const VALID = new Set(["text", "image", "video", "audio", "document"]);
  const out: CampaignAction[] = [];
  for (const raw of pasos) {
    const st = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const tipo = String(st.tipo ?? st.type ?? "");
    if (tipo === "mensaje") {
      const msgs = (Array.isArray(st.mensajes) ? st.mensajes : fallbackMessages).map((m) => {
        const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
        const type = VALID.has(String(o.type ?? "")) ? (String(o.type) as CampaignMessageItem["type"]) : "text";
        return { type, text: asStr(o.text) ?? undefined, mediaUrl: asStr(o.mediaUrl) ?? undefined };
      }).filter((m) => m.text || m.mediaUrl);
      if (msgs.length) out.push({ type: "send-message", messages: msgs });
    } else if (tipo === "esperar") {
      out.push({ type: "wait", seconds: Math.max(1, Math.round(Number(st.segundos ?? st.seconds) || 60)) });
    } else if (tipo === "etiquetar") {
      const add = tagIds(st.agregar ?? st.agregarEtiquetas);
      const remove = tagIds(st.quitar ?? st.quitarEtiquetas);
      if (add.length || remove.length) out.push({ type: "tag", ...(add.length ? { addTagIds: add } : {}), ...(remove.length ? { removeTagIds: remove } : {}) });
    } else if (tipo === "mover_crm") {
      const bName = String(st.tablero ?? "");
      const cName = String(st.columna ?? "");
      const b = boards.find((x) => x.id === bName || norm(x.name) === norm(bName));
      const c = columns.find((x) => (b ? x.crmId === b.id : true) && (x.id === cName || norm(x.name) === norm(cName)));
      if (!c) throw new AppError(`Columna «${cName}»${bName ? ` del tablero «${bName}»` : ""} no existe (ver_crm)`, 400);
      out.push({ type: "crm-move", crmId: c.crmId, columnId: c.id });
    } else if (tipo === "modo_humano") {
      out.push({ type: "handoff", notifyOwner: st.avisarDueno !== false });
    } else {
      throw new AppError(`Paso desconocido «${tipo}» (usa mensaje | esperar | etiquetar | mover_crm | modo_humano)`, 400);
    }
  }
  if (!out.length) throw new AppError("La campaña necesita al menos un paso de mensaje", 400);
  return out;
}

/** Cliente por id o por teléfono (dígitos; coincidencia parcial). */
async function findCustomerRef(companyId: string, ref: unknown) {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new AppError("Indica el teléfono o el id del cliente", 400);
  const byId = /^[0-9a-f-]{36}$/i.test(raw) ? await prisma.customer.findFirst({ where: { id: raw, companyId }, select: { id: true, name: true, phone: true } }) : null;
  if (byId) return byId;
  const digits = raw.replace(/\D/g, "");
  const c = digits ? await prisma.customer.findFirst({ where: { companyId, phone: { contains: digits } }, select: { id: true, name: true, phone: true } }) : null;
  if (!c) throw new AppError(`No encontré un cliente con «${raw}»`, 404);
  return c;
}

/**
 * Cliente (id o teléfono) + su conversación más reciente de WhatsApp/chat web,
 * con lo que necesita la compuerta de envíos manuales del copiloto.
 */
async function findChatByRef(companyId: string, ref: unknown) {
  const customer = await findCustomerRef(companyId, ref);
  const convo = await prisma.conversation.findFirst({
    where: { companyId, customerId: customer.id, channel: { in: ["whatsapp", "web"] } },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, channel: true, botPaused: true, status: true, customer: { select: { optOutAt: true } } },
  });
  if (!convo) throw new AppError(`${customer.name ?? customer.phone} no tiene conversación todavía (para escribirle por primera vez usa iniciar_conversacion)`, 404);
  return { customer, convo };
}

/** Proveedor con el que saldría un envío manual (la ventana de 24 h solo aplica a META). */
async function senderProviderFor(companyId: string, channel: string): Promise<"SMSTOOLS" | "META" | "WEB" | null> {
  if (channel === "web") return "WEB";
  const sender = await loadWhatsappSender(companyId);
  return sender?.provider ?? null;
}

/** Pausa el bot en nombre del copiloto con motivo persistente (si no estaba ya pausado). */
async function takeControlByCopilot(companyId: string, convo: { id: string; botPaused: boolean }, motivo: unknown) {
  if (convo.botPaused) return false;
  const reason = String(motivo ?? "").trim() || "Copiloto atendiendo el chat";
  await setHumanReason(convo.id, "COPILOTO", reason);
  await setBotPaused(companyId, convo.id, true, { reason });
  return true;
}

function mediaKindFromUrl(url: string, explicit?: unknown): "image" | "video" | "document" {
  const e = String(explicit ?? "").toLowerCase();
  if (e === "image" || e === "video" || e === "document") return e;
  const ext = (url.split("?")[0].split("#")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "mov", "3gp", "webm"].includes(ext)) return "video";
  const kind = mediaKindFor(ext === "pdf" ? "pdf" : "document");
  return kind === "audio" ? "document" : kind;
}

const NOTA_ATENCION_HUMANA = "El agente IA NO responderá a este cliente hasta que lo reactives con atencion_humana {activar:false}.";

/** Nombres de etiquetas → ids (error si alguna no existe). */
async function tagIdsByName(companyId: string, names: unknown): Promise<string[] | undefined> {
  const list = asStrList(names);
  if (list === null || list === undefined) return undefined;
  const tags = await prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } });
  return list.map((n) => {
    const t = tags.find((x) => x.id === n || x.name.trim().toLowerCase() === n.trim().toLowerCase());
    if (!t) throw new AppError(`La etiqueta «${n}» no existe (créala con crear_etiqueta)`, 400);
    return t.id;
  });
}

/** Tablero + columna del CRM por nombre o id → ids. Columna sin tablero: se busca en todos los tableros. */
async function resolveBoardColumn(companyId: string, tablero: string | undefined, columna: string | undefined): Promise<{ crmId: string; crmColumnId: string }> {
  const [boards, columns] = await Promise.all([
    prisma.crm.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crmColumn.findMany({ where: { crm: { companyId } }, select: { id: true, name: true, crmId: true } }),
  ]);
  const norm = (v: string) => v.trim().toLowerCase();
  let crmId: string | null = null;
  if (tablero?.trim()) {
    const b = boards.find((x) => x.id === tablero || norm(x.name) === norm(tablero));
    if (!b) throw new AppError(`El tablero «${tablero}» no existe (ver_crm lista los tableros)`, 400);
    crmId = b.id;
  }
  if (!columna?.trim()) throw new AppError("Indica también la columna del tablero (columna)", 400);
  const cands = columns.filter((c) => (crmId ? c.crmId === crmId : true));
  const c = cands.find((x) => x.id === columna || norm(x.name) === norm(columna));
  if (!c) throw new AppError(`La columna «${columna}» no existe${crmId ? " en ese tablero" : ""} (ver_crm lista las columnas)`, 400);
  return { crmId: c.crmId, crmColumnId: c.id };
}

/** Acciones de una respuesta rápida por NOMBRES (tablero, columna, etiquetas, producto) → ids. Nombre inexistente = error claro. */
async function resolveQuickReplyActions(
  companyId: string,
  raw: LooseData,
  current: Record<string, unknown> | null,
): Promise<{ tagIds: string[]; removeTagIds: string[]; crmId: string | null; crmColumnId: string | null; markDelivered: boolean; presentProductId: string | null } | null> {
  const cur = current ?? {};
  const [tags, boards, columns, products] = await Promise.all([
    prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crm.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crmColumn.findMany({ where: { crm: { companyId } }, select: { id: true, name: true, crmId: true } }),
    prisma.product.findMany({ where: { companyId }, select: { id: true, name: true } }),
  ]);
  const norm = (v: string) => v.trim().toLowerCase();
  const tagIdsFrom = (names: string[] | null | undefined, keepCurrent: unknown): string[] => {
    if (names === undefined) return Array.isArray(keepCurrent) ? (keepCurrent as string[]) : [];
    if (names === null) return [];
    return names.map((n) => {
      const t = tags.find((x) => x.id === n || norm(x.name) === norm(n));
      if (!t) throw new AppError(`La etiqueta «${n}» no existe (créala con crear_etiqueta)`, 400);
      return t.id;
    });
  };
  const tagIds = tagIdsFrom(raw.agregarEtiquetas === undefined ? undefined : (asStrList(raw.agregarEtiquetas) ?? null), cur.tagIds);
  const removeTagIds = tagIdsFrom(raw.quitarEtiquetas === undefined ? undefined : (asStrList(raw.quitarEtiquetas) ?? null), cur.removeTagIds);
  let crmId = typeof cur.crmId === "string" ? cur.crmId : null;
  let crmColumnId = typeof cur.crmColumnId === "string" ? cur.crmColumnId : null;
  if (raw.tablero === null || raw.columna === null) { crmId = null; crmColumnId = null; }
  if (typeof raw.tablero === "string" && raw.tablero.trim()) {
    const b = boards.find((x) => x.id === raw.tablero || norm(x.name) === norm(String(raw.tablero)));
    if (!b) throw new AppError(`El tablero «${raw.tablero}» no existe (ver_crm lista los tableros)`, 400);
    crmId = b.id;
    if (raw.columna === undefined) crmColumnId = null;
  }
  if (typeof raw.columna === "string" && raw.columna.trim()) {
    const cands = columns.filter((c) => (crmId ? c.crmId === crmId : true));
    const c = cands.find((x) => x.id === raw.columna || norm(x.name) === norm(String(raw.columna)));
    if (!c) throw new AppError(`La columna «${raw.columna}» no existe${crmId ? " en ese tablero" : ""} (ver_crm lista las columnas)`, 400);
    crmId = c.crmId;
    crmColumnId = c.id;
  }
  if (crmId && !crmColumnId) throw new AppError("Indica también la columna del tablero (columna)", 400);
  let presentProductId = typeof cur.presentProductId === "string" ? cur.presentProductId : null;
  if (raw.presentaProducto === null) presentProductId = null;
  else if (typeof raw.presentaProducto === "string" && raw.presentaProducto.trim()) {
    const p = products.find((x) => x.id === raw.presentaProducto || norm(x.name) === norm(String(raw.presentaProducto)));
    if (!p) throw new AppError(`El producto «${raw.presentaProducto}» no existe`, 400);
    presentProductId = p.id;
  }
  const markDelivered = typeof raw.marcarEntregado === "boolean" ? raw.marcarEntregado : cur.markDelivered === true;
  const out = { tagIds, removeTagIds, crmId, crmColumnId, markDelivered, presentProductId };
  const empty = !tagIds.length && !removeTagIds.length && !crmId && !markDelivered && !presentProductId;
  return empty ? null : out;
}

/** Flujo por id o por nombre (trim + case-insensitive). */
async function findFlowRef(companyId: string, ref: string | undefined) {
  const r = (ref ?? "").trim();
  if (!r) throw new AppError("Indica el flujo (id o nombre)", 400);
  const byId = await prisma.chatFlow.findFirst({ where: { id: r, companyId }, select: { id: true } }).catch(() => null);
  if (byId) return getFlow(companyId, byId.id);
  const all = await prisma.chatFlow.findMany({ where: { companyId }, select: { id: true, name: true } });
  const hit = all.find((f) => f.name.trim().toLowerCase() === r.toLowerCase());
  if (!hit) throw new AppError(`El flujo «${r}» no existe (listar_flujos)`, 404);
  return getFlow(companyId, hit.id);
}

/** El MCP no pasa por billingGuard: el módulo Flujos se verifica aquí. */
async function assertFlowsAllowedByPlan(companyId: string) {
  const ent = await getEntitlements(companyId);
  if (!ent.legacy && !ent.modules.includes("FLOWS")) {
    throw new AppError("Tu paquete no incluye Flujos guiados. Mejora tu plan para activarlo.", 403, { code: "MODULE_NOT_AVAILABLE" });
  }
}

function flowErrorDetails(err: unknown): string {
  if (!(err instanceof AppError) || err.code !== "FLOW_INVALID") return "";
  const errs = (err.details as { errors?: { message: string }[] } | undefined)?.errors ?? [];
  return errs.length ? ` — ${errs.map((e) => e.message).join("; ")}` : "";
}

/** Acciones de una respuesta rápida con nombres (para ver_respuestas_rapidas). */
async function describeQuickReplyActions(companyId: string, replies: { actions: unknown }[]) {
  const [tags, boards, columns, products] = await Promise.all([
    prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crm.findMany({ where: { companyId }, select: { id: true, name: true } }),
    prisma.crmColumn.findMany({ where: { crm: { companyId } }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { companyId }, select: { id: true, name: true } }),
  ]);
  const nameOf = (list: { id: string; name: string }[], id: unknown) => (typeof id === "string" ? list.find((x) => x.id === id)?.name ?? null : null);
  return replies.map((r) => {
    const a = (r.actions && typeof r.actions === "object" ? r.actions : {}) as Record<string, unknown>;
    const names = (ids: unknown) => (Array.isArray(ids) ? ids.map((id) => nameOf(tags, id)).filter(Boolean) : []);
    const out = {
      agregarEtiquetas: names(a.tagIds),
      quitarEtiquetas: names(a.removeTagIds),
      tablero: nameOf(boards, a.crmId),
      columna: nameOf(columns, a.crmColumnId),
      marcarEntregado: a.markDelivered === true,
      presentaProducto: nameOf(products, a.presentProductId),
    };
    const any = out.agregarEtiquetas.length || out.quitarEtiquetas.length || out.tablero || out.marcarEntregado || out.presentaProducto;
    return any ? out : null;
  });
}

async function resolveQuickReplyCategory(companyId: string, name?: string): Promise<string | undefined> {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  const categories = await listCategories(companyId);
  const found = categories.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (found) return found.id;
  const created = await createCategory(companyId, trimmed);
  return created.id;
}

export async function runCopilotTool(
  companyId: string,
  name: string,
  args: LooseData,
  attachmentsByUrl: Map<string, CopilotAttachment>,
): Promise<{ result: string; wrote: boolean }> {
  switch (name) {
    case "adjuntar_foto_producto": {
      const url = String(args.url ?? "").trim();
      // Adjunto de la conversación, o un archivo de NUESTROS uploads (p. ej.
      // una imagen recién creada con generar_imagen).
      const meta = resolveAttachment(url, attachmentsByUrl) ?? (await resolveOwnUploadImage(url));
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
          nota:
            (principal ? "Imagen adjuntada como foto PRINCIPAL del producto." : "Imagen adjuntada al producto.") +
            " OJO: si la intención era ponerla como BANNER del mensaje de presentación (viaja con la ficha como media+caption), eso NO es esto — usa actualizar_producto {data:{presentationMessageMediaUrl: <url>}} y verifica con previsualizar_ficha.",
        }),
        wrote: true,
      };
    }

    case "generar_imagen": {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) return { result: JSON.stringify({ ok: false, error: "falta el prompt de la imagen" }), wrote: false };
      const cfgRow = await prisma.agentConfig.findUnique({
        where: { companyId },
        select: { aiProvider: true, openaiModel: true, openaiApiKey: true, transcriptionApiKey: true, temperature: true },
      });
      const apiKey = cfgRow ? resolveAiSettings(cfgRow).transcriptionApiKey : "";
      if (!apiKey) {
        return {
          result: JSON.stringify({
            ok: false,
            error:
              "El negocio no tiene una key de OpenAI configurada para generar imágenes. Deriva al panel: Agente IA → key de OpenAI (si su proveedor es Anthropic/Gemini, el campo de key para audios e imágenes). NUNCA pidas la key por chat.",
          }),
          wrote: false,
        };
      }
      const formato = String(args.formato ?? "cuadrado").toLowerCase();
      const size: ImageGenSize = formato === "horizontal" ? "1536x1024" : formato === "vertical" ? "1024x1536" : "1024x1024";
      const quality: ImageGenQuality = String(args.calidad ?? "").toLowerCase() === "alta" ? "high" : "medium";
      try {
        const buffer = await generateImage({ apiKey, prompt, size, quality });
        const saved = await saveGeneratedImage(companyId, buffer);
        return {
          result: JSON.stringify({
            ok: true,
            url: saved.url,
            formato,
            nota:
              "Imagen generada y guardada. MUÉSTRALE la URL al usuario para que la vea y la APRUEBE antes de adjuntarla. Destinos concretos: BANNER del mensaje de presentación → actualizar_producto {data:{presentationMessageMediaUrl}}; paso de recordatorio → actualizar_producto {data:{reminderConfig:{...steps con mediaUrl}}}; mensajes adicionales de presentación → actualizar_producto {data:{presentationFollowups}}; respuesta rápida → crear/actualizar_respuesta_rapida (mediaUrl en messages); campaña → crear_campana (mediaUrl en mensajes); foto de producto → adjuntar_foto_producto. Verifica con previsualizar_ficha cuando toque la presentación. Para reutilizar multimedia YA subida en vez de generar, listar_recursos da las URLs.",
          }),
          wrote: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "no se pudo generar la imagen";
        return { result: JSON.stringify({ ok: false, error: message }), wrote: false };
      }
    }

    case "configurar_archivo_producto": {
      const productId = String(args.productId ?? "");
      const existing = await getProduct(companyId, productId);
      const files = (existing.files ?? []) as Array<
        { url?: string; originalName?: string; sortOrder?: number; description?: string; showInPresentation?: boolean; sendByEmail?: boolean } & Record<string, unknown>
      >;
      if (!files.length) {
        return { result: JSON.stringify({ ok: false, error: "Este producto no tiene archivos subidos (súbelos desde el panel, paso Archivos)." }), wrote: false };
      }
      // Match tolerante: URL exacta → nombre exacto → único match parcial (url o nombre).
      const key = String(args.archivo ?? "").trim();
      const keyLower = key.toLowerCase();
      let matches = files.filter((f) => f.url === key);
      if (!matches.length) matches = files.filter((f) => (f.originalName ?? "").toLowerCase() === keyLower);
      if (!matches.length) {
        matches = files.filter(
          (f) => (f.url ?? "").toLowerCase().includes(keyLower) || (f.originalName ?? "").toLowerCase().includes(keyLower),
        );
      }
      const available = files.map((f) => ({ nombre: f.originalName ?? "", url: f.url ?? "" }));
      if (!matches.length) {
        return { result: JSON.stringify({ ok: false, error: "No encontré ese archivo en el producto.", archivosDisponibles: available }), wrote: false };
      }
      if (matches.length > 1) {
        return {
          result: JSON.stringify({ ok: false, error: "Hay varios archivos que coinciden — usa la URL exacta.", coincidencias: matches.map((f) => f.url) }),
          wrote: false,
        };
      }
      const target = matches[0];
      const updated = files.map((f) =>
        f === target
          ? {
              ...f,
              ...(typeof args.showInPresentation === "boolean" ? { showInPresentation: args.showInPresentation } : {}),
              ...(typeof args.adjuntarEnCorreo === "boolean" ? { sendByEmail: args.adjuntarEnCorreo } : {}),
              ...(typeof args.privado === "boolean" ? { privateDownload: args.privado } : {}),
              ...(args.description !== undefined ? { description: asStr(args.description) ?? "" } : {}),
            }
          : f,
      );
      // principal=true: el archivo pasa a ser el primero (ficha/catálogo); el resto conserva su orden relativo.
      const ordered =
        args.principal === true
          ? (() => {
              const rest = updated.filter((f) => f.url !== target.url);
              const first = updated.find((f) => f.url === target.url)!;
              return [first, ...rest].map((f, i) => ({ ...f, sortOrder: i }));
            })()
          : updated;
      const payload = buildPayload({}, existing);
      payload.files = ordered as never[];
      const parsed = productBodySchema.safeParse(payload);
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      await updateProduct(companyId, productId, parsed.data as Parameters<typeof updateProduct>[2]);
      return {
        result: JSON.stringify({
          ok: true,
          product: existing.name,
          archivo: target.originalName ?? target.url,
          nota: "Metadata actualizada. Verifica la presentación resultante con previsualizar_ficha.",
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

    case "previsualizar_ficha": {
      // El MISMO BotProduct (precio efectivo, archivos, planes) que usa el agente
      // real: la preview replica las ramas de enviar_ficha sin enviar nada.
      const cfg = await buildBotConfig(companyId);
      const productId = String(args.productId ?? "");
      const botProduct = (cfg.products ?? []).find((p) => p.id === productId);
      if (!botProduct) {
        return {
          result: JSON.stringify({ ok: false, error: "Producto no encontrado o inactivo (la preview usa el catálogo que ve el agente)." }),
          wrote: false,
        };
      }
      const vertical = (cfg.business as { vertical?: string }).vertical;
      const preview = buildFichaPreview(botProduct, vertical, symbolFor((cfg.business as { currency?: string }).currency));
      return {
        result: JSON.stringify({
          ok: true,
          producto: botProduct.name,
          ...preview,
          nota: "Esta es la secuencia EXACTA que el agente envía al presentar el producto (enviar_ficha). Analízala como la vería el cliente.",
        }),
        wrote: false,
      };
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
            meetingUrl: true,
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
            unknownHandoff: true,
            humanChatAlerts: true,
            catalogMode: true,
            keywordMode: true,
            trackStock: true,
            catalogMediaMode: true,
            followupConfig: true,
            crmToolConfig: true,
          },
        }),
        prisma.paymentConfig.findUnique({
          where: { companyId },
          include: { methods: { orderBy: { sortOrder: "asc" } } },
        }),
      ]);
      // Recordatorios: valores EFECTIVOS (con defaults) para que el copiloto pueda
      // analizar/ajustar la protección anti-bloqueo sin adivinar.
      const fu = (agent?.followupConfig ?? null) as {
        abandonedCart?: { enabled?: boolean; steps?: unknown[] };
        leftOnRead?: { enabled?: boolean; steps?: unknown[] };
        quietHours?: unknown;
        pacing?: unknown;
        metaTemplate?: unknown;
      } | null;
      const quiet = normalizeQuietHours(fu?.quietHours);
      const pacing = normalizePacing(fu?.pacing, {
        minSec: env.REMINDER_PACING_MIN_SEC,
        maxSec: env.REMINDER_PACING_MAX_SEC,
        maxPerHour: env.REMINDER_MAX_PER_HOUR,
      });
      const seqInfo = (s?: { enabled?: boolean; steps?: unknown[] }) => ({
        enabled: Boolean(s?.enabled),
        pasos: Array.isArray(s?.steps) ? s.steps.length : 0,
      });
      const { followupConfig: _fu, crmToolConfig: _crmTool, ...agentRest } = agent ?? { followupConfig: null, crmToolConfig: null };
      const crmToolView = await describeCrmToolConfig(companyId, agent?.crmToolConfig);
      void _fu;
      return {
        result: JSON.stringify({
          empresa: company ? { ...company, productCount: company._count.products, _count: undefined } : null,
          agente: agent ? { ...agentRest, herramientaCrm: crmToolView } : null,
          recordatorios: {
            abandonedCart: seqInfo(fu?.abandonedCart),
            leftOnRead: seqInfo(fu?.leftOnRead),
            horario: {
              enviarDesde: `${String(quiet.startHour).padStart(2, "0")}:00`,
              enviarHasta: `${String(quiet.endHour).padStart(2, "0")}:00`,
              dispersionAlAbrirMin: quiet.spreadMinutes,
            },
            ritmoAntiBloqueo: {
              pausaEntreEnviosSeg: { min: pacing.minSec, max: pacing.maxSec },
              maximoPorHora: pacing.maxPerHour,
              nota: "Con campaña enviando, la pausa se duplica. Configurable con configurar_recordatorios {quietHours.spreadMinutes, pacing}.",
            },
            plantillaMeta: fu?.metaTemplate ?? null,
          },
          tienda: await getStorefrontConfig(companyId)
            .then((c) => ({ enabled: c.enabled, url: c.status.url, lista: c.status.lista }))
            .catch(() => null),
          pagos: payment
            ? {
                enabled: payment.enabled,
                paymentMode: payment.paymentMode,
                notificationPhone: payment.notificationPhone,
                methods: payment.methods.map((m) => ({ method: m.method, number: m.number, holder: m.holder })),
                mercadoPago: {
                  conectado: Boolean(payment.mpAccessToken),
                  activo: payment.mpEnabled,
                  canales: { chat: payment.mpChatEnabled, tienda: payment.mpStoreEnabled },
                  nota: "Se conecta en Integraciones (token solo desde el panel); los canales se cambian con configurar_pagos {mpChatEnabled, mpStoreEnabled}.",
                },
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
      const botModeIn = asStr(data.botMode)?.trim().toUpperCase();
      if (botModeIn && !["AI", "FLOW", "HYBRID"].includes(botModeIn)) {
        return { result: JSON.stringify({ ok: false, error: "botMode debe ser AI, FLOW o HYBRID" }), wrote: false };
      }
      if (botModeIn && botModeIn !== "FLOW") {
        const ac = await prisma.agentConfig.findUnique({ where: { companyId }, select: { openaiApiKey: true } });
        if (!ac?.openaiApiKey) {
          return { result: JSON.stringify({ ok: false, error: `El modo ${botModeIn} necesita la key de IA configurada en Agente IA (desde el panel; nunca por chat).` }), wrote: false };
        }
      }
      const updated = await updateBusinessProfile(companyId, {
        name: asStr(data.name) ?? current.name,
        slug: current.slug,
        adminPhone: asStr(data.adminPhone) ?? current.adminPhone,
        vertical: (asStr(data.vertical) as typeof current.vertical | undefined) ?? current.vertical,
        timezone: asStr(data.timezone) ?? current.timezone,
        currency: ((asStr(data.currency)?.toUpperCase() === "USD" ? "USD" : asStr(data.currency)?.toUpperCase() === "PEN" ? "PEN" : undefined) as "PEN" | "USD" | undefined) ?? (current.currency as "PEN" | "USD"),
        botMode: (botModeIn as "AI" | "FLOW" | "HYBRID" | undefined) ?? (current.botMode as "AI" | "FLOW" | "HYBRID"),
        isActive: current.isActive,
        // undefined = no tocar (el service ya respeta esa semántica).
        deliveryConfig: data.deliveryConfig !== undefined ? (data.deliveryConfig as DeliveryConfigInput | null) : undefined,
        businessHours:
          data.businessHours !== undefined
            ? (data.businessHours as Array<{ day: number; from: string; to: string }> | null)
            : undefined,
        meetingUrl: data.meetingUrl !== undefined ? asStr(data.meetingUrl) ?? null : undefined,
        firmaEnabled: typeof data.firmaEnabled === "boolean" ? data.firmaEnabled : current.firmaEnabled,
        firmaText: data.firmaText !== undefined ? asStr(data.firmaText) ?? null : current.firmaText,
        messageGapEnabled: current.messageGapEnabled,
        messageGapSeconds: current.messageGapSeconds,
      });
      return {
        result: JSON.stringify({ ok: true, empresa: { name: updated.name, vertical: updated.vertical, timezone: updated.timezone, currency: (updated as { currency?: string }).currency }, nota: "Empresa actualizada (lo no enviado se conservó)." }),
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
        unknownHandoff: typeof data.unknownHandoff === "boolean" ? data.unknownHandoff : (current.unknownHandoff ?? false),
        humanChatAlerts: typeof data.humanChatAlerts === "boolean" ? data.humanChatAlerts : (current.humanChatAlerts ?? true),
        catalogMode: asStr(data.catalogMode) ?? (current.catalogMode as string),
        keywordMode: asStr(data.keywordMode) ?? (current.keywordMode as string),
        trackStock: typeof data.trackStock === "boolean" ? data.trackStock : (current.trackStock ?? true),
        catalogMediaMode: asStr(data.catalogMediaMode) ?? (current.catalogMediaMode as string),
        ...(data.crmTool !== undefined ? { crmToolConfig: await resolveCrmToolConfig(companyId, data.crmTool) } : {}),
      });
      return {
        result: JSON.stringify({ ok: true, nota: "Agente IA actualizado (la API key y el modelo no se tocaron)." + (data.crmTool !== undefined ? " Herramienta de CRM del agente guardada; ver_configuracion la muestra con nombres." : "") }),
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
      // Mercado Pago por canal (no toca el token ni la comisión).
      let mpNota = "";
      if (typeof data.mpChatEnabled === "boolean" || typeof data.mpStoreEnabled === "boolean") {
        if (!current?.mpAccessToken) {
          mpNota = " Mercado Pago NO está conectado: los canales se guardarán pero no aplican hasta conectar el token en Integraciones.";
        }
        await updateMercadoPagoConfig(companyId, {
          enabled: current?.mpEnabled ?? false,
          feeMode: (current?.mpFeeMode as "TENANT" | "CUSTOMER") ?? "TENANT",
          feePercent: Number(current?.mpFeePercent ?? 3.99),
          feeFixed: Number(current?.mpFeeFixed ?? 1),
          feeIgv: current?.mpFeeIgv ?? true,
          ...(typeof data.mpChatEnabled === "boolean" ? { chatEnabled: data.mpChatEnabled } : {}),
          ...(typeof data.mpStoreEnabled === "boolean" ? { storeEnabled: data.mpStoreEnabled } : {}),
        });
      }
      return { result: JSON.stringify({ ok: true, nota: "Pagos actualizados (lo no enviado se conservó)." + mpNota }), wrote: true };
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
      const acciones = await describeQuickReplyActions(companyId, replies);
      return {
        result: JSON.stringify({
          respuestas: replies.map((r, i) => ({
            id: r.id,
            title: r.title,
            command: r.command,
            categoryId: r.categoryId,
            // Contenido COMPLETO (máx 10 por respuesta): sin esto el modelo no
            // puede auditar/editar sin riesgo de perder lo existente.
            mensajes: Array.isArray(r.messages) ? r.messages : [],
            // Acciones al enviar (CRM, etiquetas, entregado, producto) con nombres.
            acciones: acciones[i],
          })),
          categorias: categories,
          nota:
            "Para modificar una usa actualizar_respuesta_rapida {quickReplyId, data, reemplazarMensajes?}: los messages enviados se AGREGAN al final; reemplazarMensajes=true reescribe la secuencia completa (envía la versión final). Las acciones (tablero/columna del CRM, etiquetas a agregar/quitar, marcarEntregado, presentaProducto) se cambian con data.acciones por NOMBRES.",
        }),
        wrote: false,
      };
    }

    case "crear_respuesta_rapida": {
      const categoryId = await resolveQuickReplyCategory(companyId, asStr(args.category));
      let actions: Awaited<ReturnType<typeof resolveQuickReplyActions>> = null;
      if (args.acciones && typeof args.acciones === "object") {
        try {
          actions = await resolveQuickReplyActions(companyId, args.acciones as LooseData, null);
        } catch (err) {
          return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "acciones inválidas" }), wrote: false };
        }
      }
      const parsed = upsertQuickReplySchema.safeParse({
        title: String(args.title ?? "").trim(),
        command: asStr(args.command) ?? null,
        ...(categoryId ? { categoryId } : {}),
        messages: Array.isArray(args.messages) ? args.messages : [],
        ...(actions ? { actions } : {}),
      });
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      try {
        const created = await createQuickReply(companyId, parsed.data);
        const [acc] = await describeQuickReplyActions(companyId, [created]);
        return { result: JSON.stringify({ ok: true, quickReplyId: created.id, title: created.title, command: created.command, acciones: acc }), wrote: true };
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
      let nextActions: unknown = current.actions ?? null;
      if (data.acciones !== undefined) {
        if (data.acciones === null) nextActions = null;
        else {
          try {
            nextActions = await resolveQuickReplyActions(companyId, data.acciones as LooseData, (current.actions ?? null) as Record<string, unknown> | null);
          } catch (err) {
            return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "acciones inválidas" }), wrote: false };
          }
        }
      }
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
        ...(nextActions ? { actions: nextActions } : {}),
      });
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      try {
        const updated = await updateQuickReply(companyId, quickReplyId, parsed.data);
        const [acc] = await describeQuickReplyActions(companyId, [updated]);
        return { result: JSON.stringify({ ok: true, title: updated.title, command: updated.command, acciones: acc, nota: "Respuesta rápida actualizada (lo no enviado se conservó)." }), wrote: true };
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
      // Respuestas del chatbot de flujos (📝 en la tarjeta): por clave o todas ("*").
      const quitarVars = asStrList(args.quitarRespuestasFlujo) ?? [];
      let respuestasEliminadas: string[] | undefined;
      if (quitarVars.length) {
        const r = await removeCustomerFlowVars(companyId, customer.id, quitarVars.includes("*") ? null : quitarVars);
        respuestasEliminadas = r.removed;
      }
      return {
        result: JSON.stringify({
          ok: true,
          customer: customer.name ?? customer.phone,
          ...(respuestasEliminadas ? { respuestasEliminadas } : {}),
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

    case "ver_tienda": {
      const cfg = await getStorefrontConfig(companyId);
      const limit = Math.min(Math.max(Number(args.pedidos) || 10, 1), 50);
      const [orders, review, metricas30d, correos] = await Promise.all([
        listStoreOrders(companyId, 1, limit),
        listStoreOrders(companyId, 1, 20, "EN_REVISION"),
        storeMetrics(companyId, { days: Number(args.dias) || 30, from: asStr(args.desde) ?? undefined, to: asStr(args.hasta) ?? undefined, productId: asStr(args.productId) ?? null }).catch(() => null),
        listStoreEmails(companyId, undefined, 10).catch(() => null),
      ]);
      return {
        result: JSON.stringify({
          activa: cfg.enabled,
          url: cfg.status.url,
          lista: cfg.status.lista,
          checklist: {
            slugValido: cfg.status.slugValido,
            slugProblema: cfg.status.slugProblema,
            moduloTienda: cfg.status.moduloTienda,
            moduloMercadoPago: cfg.status.moduloMp,
            mercadoPagoConfigurado: cfg.status.mpConfigurado,
            yapePlinDisponible: cfg.status.pagosManuales,
            yapePlinHabilitadoEnTienda: cfg.status.manualHabilitado,
            metodosManuales: cfg.status.metodosManuales,
            productosElegibles: cfg.status.productosElegibles,
            productosSinEntregaPorCorreo: cfg.status.productosSinCorreo,
          },
          config: {
            title: cfg.title, tagline: cfg.tagline, accentColor: cfg.accentColor, logoUrl: cfg.logoUrl, whatsappNumber: cfg.whatsappNumber, productIds: cfg.productIds, manualPaymentsEnabled: cfg.manualPaymentsEnabled,
            portada: { heroSlides: cfg.heroSlides, carouselAutoplay: cfg.carouselAutoplay, carouselIntervalSec: cfg.carouselIntervalSec, showOldPrice: cfg.showOldPrice, trustItems: cfg.trustItems, faqs: cfg.faqs, footerTagline: cfg.footerTagline },
            productOverrides: cfg.productOverrides,
            ventas: { announcement: cfg.announcement, volumePricing: cfg.volumePricing, salesSettings: cfg.salesSettings },
          },
          metricas: metricas30d,
          correos: correos ? { ...correos.stats, recientes: correos.items.map((m) => ({ tipo: m.kind, para: m.email, asunto: m.subject, estado: m.status, enviaEl: m.sendAt })) } : null,
          correosAutomaticos: cfg.emailReminders,
          pedidosEnRevision: review.items.map((o) => ({
            id: o.id,
            fecha: o.createdAt,
            producto: o.productName,
            comprador: o.name,
            email: o.email,
            monto: o.amountText,
            nombrePagador: o.payerName,
            comprobanteUrl: o.receiptMediaUrl,
            lecturaVision: o.comprobante,
            reintentosAutomaticos: o.recheckAttempts,
          })),
          pedidosRecientes: { total: orders.total, items: orders.items.map((o) => ({ id: o.id, fecha: o.createdAt, producto: o.productName, comprador: o.name, email: o.email, whatsapp: o.phone, monto: o.amountText, metodo: o.paymentMethod === "MANUAL" ? "Yape/Plin" : "Mercado Pago", estado: o.status, motivo: o.failureReason })) },
          nota: "Los pedidos ENTREGADOS son ventas reales (comprobante aprobado, canal 'tienda web'). EN_REVISION = el comprador subió su comprobante Yape/Plin y no hubo validación automática: el dueño lo revisa (aprobar_pedido_tienda / rechazar_pedido_tienda). Un producto solo se vende en la tienda si es digital, está en catálogo y tiene entrega por correo activa.",
        }),
        wrote: false,
      };
    }

    case "listar_campanas_correo": {
      return { result: JSON.stringify({ campanas: await listEmailCampaigns(companyId) }), wrote: false };
    }

    case "previsualizar_audiencia_correo": {
      return { result: JSON.stringify(await previewEmailAudience(companyId, args.audience)), wrote: false };
    }

    case "crear_campana_correo": {
      const name = asStr(args.name) ?? "";
      const subject = asStr(args.subject) ?? "";
      const body = asStr(args.body) ?? "";
      if (!name || !subject || !body) return { result: JSON.stringify({ ok: false, error: "faltan name/subject/body" }), wrote: false };
      const c = await createEmailCampaign(companyId, { name, subject, body, ctaLabel: asStr(args.ctaLabel) ?? null, ctaUrl: asStr(args.ctaUrl) ?? null, couponCode: asStr(args.couponCode) ?? null, audience: args.audience ?? { source: "buyers" } });
      if (args.enviar === true) {
        const started = await startEmailCampaign(companyId, c.id, { scheduledAt: asStr(args.scheduledAt) ?? null });
        return { result: JSON.stringify({ ok: true, campana: started, nota: started.status === "SCHEDULED" ? "Programada." : "Enviándose (ritmo controlado)." }), wrote: true };
      }
      return { result: JSON.stringify({ ok: true, campana: c, nota: "Quedó en BORRADOR: el dueño la revisa y envía desde Tienda web → Correos → Promociones (o vuelve a llamar con enviar=true)." }), wrote: true };
    }

    case "enviar_prueba_campana_correo": {
      const id = asStr(args.campaignId) ?? "";
      const to = asStr(args.to) ?? "";
      if (!id || !to) return { result: JSON.stringify({ ok: false, error: "faltan campaignId/to" }), wrote: false };
      return { result: JSON.stringify(await sendEmailCampaignTest(companyId, id, to)), wrote: true };
    }

    case "ver_cupones": {
      return { result: JSON.stringify({ cupones: await listCoupons(companyId) }), wrote: false };
    }

    case "crear_cupon": {
      const type = args.type === "FIXED" ? "FIXED" : "PERCENT";
      const value = Number(args.value);
      if (!asStr(args.code) || !Number.isFinite(value)) return { result: JSON.stringify({ ok: false, error: "faltan code/value" }), wrote: false };
      const c = await createCoupon(companyId, {
        code: asStr(args.code)!,
        type,
        value,
        productIds: asStrList(args.productIds) ?? [],
        maxUses: typeof args.maxUses === "number" ? args.maxUses : null,
        expiresAt: asStr(args.expiresAt) ?? null,
      });
      return { result: JSON.stringify({ ok: true, cupon: c, nota: "El comprador escribe el código en el checkout de la tienda web." }), wrote: true };
    }

    case "editar_cupon": {
      const id = asStr(args.couponId) ?? "";
      if (!id) return { result: JSON.stringify({ ok: false, error: "falta couponId" }), wrote: false };
      const c = await updateCoupon(companyId, id, {
        ...(args.maxUses !== undefined ? { maxUses: typeof args.maxUses === "number" ? args.maxUses : null } : {}),
        ...(args.expiresAt !== undefined ? { expiresAt: asStr(args.expiresAt) ?? null } : {}),
        ...(args.productIds !== undefined ? { productIds: asStrList(args.productIds) ?? [] } : {}),
        ...(typeof args.active === "boolean" ? { active: args.active } : {}),
      });
      return { result: JSON.stringify({ ok: true, cupon: c }), wrote: true };
    }

    case "desactivar_cupon": {
      const id = asStr(args.couponId) ?? "";
      if (!id) return { result: JSON.stringify({ ok: false, error: "falta couponId" }), wrote: false };
      const c = await updateCoupon(companyId, id, { active: typeof args.active === "boolean" ? args.active : false });
      return { result: JSON.stringify({ ok: true, cupon: c }), wrote: true };
    }

    case "aprobar_pedido_tienda": {
      const orderId = asStr(args.orderId) ?? "";
      if (!orderId) return { result: JSON.stringify({ ok: false, error: "falta orderId" }), wrote: false };
      const o = await approveStoreOrder(companyId, orderId, { note: asStr(args.nota) ?? null });
      return {
        result: JSON.stringify({ ok: true, estado: o.status, producto: o.productName, comprador: o.name, email: o.email, monto: o.amountText, motivo: o.failureReason, nota: o.status === "ENTREGADO" ? "Pago aprobado y acceso enviado por correo." : "Pago aprobado pero la entrega falló; revisa el motivo y reenvía desde la ficha del cliente." }),
        wrote: true,
      };
    }

    case "eliminar_pedido_tienda": {
      const orderId = asStr(args.orderId) ?? "";
      if (!orderId) return { result: JSON.stringify({ ok: false, error: "falta orderId" }), wrote: false };
      return { result: JSON.stringify(await deleteStoreOrder(companyId, orderId)), wrote: true };
    }

    case "rechazar_pedido_tienda": {
      const orderId = asStr(args.orderId) ?? "";
      if (!orderId) return { result: JSON.stringify({ ok: false, error: "falta orderId" }), wrote: false };
      const o = await rejectStoreOrder(companyId, orderId, { reason: asStr(args.motivo) ?? null });
      return { result: JSON.stringify({ ok: true, estado: o.status, motivo: o.failureReason }), wrote: true };
    }

    case "configurar_tienda": {
      const data = (args.data ?? {}) as LooseData;
      const parsed = updateStorefrontConfigSchema.safeParse({
        ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}),
        ...(data.title !== undefined ? { title: asStr(data.title) } : {}),
        ...(data.tagline !== undefined ? { tagline: asStr(data.tagline) } : {}),
        ...(data.accentColor !== undefined ? { accentColor: asStr(data.accentColor) } : {}),
        ...(data.logoUrl !== undefined ? { logoUrl: asStr(data.logoUrl) ?? null } : {}),
        ...(data.whatsappNumber !== undefined ? { whatsappNumber: asStr(data.whatsappNumber) } : {}),
        ...(data.productIds !== undefined ? { productIds: asStrList(data.productIds) ?? [] } : {}),
        ...(typeof data.manualPaymentsEnabled === "boolean" ? { manualPaymentsEnabled: data.manualPaymentsEnabled } : {}),
        ...(data.heroSlides !== undefined ? { heroSlides: data.heroSlides } : {}),
        ...(typeof data.carouselAutoplay === "boolean" ? { carouselAutoplay: data.carouselAutoplay } : {}),
        ...(data.carouselIntervalSec !== undefined ? { carouselIntervalSec: data.carouselIntervalSec } : {}),
        ...(typeof data.showOldPrice === "boolean" ? { showOldPrice: data.showOldPrice } : {}),
        ...(data.trustItems !== undefined ? { trustItems: data.trustItems } : {}),
        ...(data.faqs !== undefined ? { faqs: data.faqs } : {}),
        ...(data.footerTagline !== undefined ? { footerTagline: asStr(data.footerTagline) ?? null } : {}),
        ...(data.productOverrides !== undefined ? { productOverrides: data.productOverrides } : {}),
        ...(data.emailReminders !== undefined ? { emailReminders: data.emailReminders } : {}),
        ...(data.announcement !== undefined ? { announcement: data.announcement } : {}),
        ...(data.volumePricing !== undefined ? { volumePricing: data.volumePricing } : {}),
        ...(data.salesSettings !== undefined ? { salesSettings: data.salesSettings } : {}),
      });
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      const cfg = await updateStorefrontConfig(companyId, parsed.data);
      return {
        result: JSON.stringify({
          ok: true,
          activa: cfg.enabled,
          url: cfg.status.url,
          lista: cfg.status.lista,
          pendientes: {
            ...(cfg.status.slugProblema ? { slug: cfg.status.slugProblema } : {}),
            ...(cfg.status.pagosListos ? {} : { pagos: "Sin cobro disponible: conecta Mercado Pago en Integraciones (token solo desde el panel) y habilítalo para la tienda (configurar_pagos {mpStoreEnabled:true}), o configura métodos Yape/Plin en Pagos (configurar_pagos) con manualPaymentsEnabled=true." }),
            ...(cfg.status.productosElegibles.length ? {} : { productos: "Ningún producto elegible: activa la entrega por correo en los productos digitales." }),
          },
          nota: cfg.status.lista ? "Tienda lista para vender." : "Tienda guardada; revisa los pendientes antes de compartir la URL.",
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
        ...(data.quietHours !== undefined
          ? {
              // Fusión parcial: permite cambiar solo spreadMinutes sin repetir start/end.
              quietHours: {
                ...(((current?.followupConfig as { quietHours?: Record<string, unknown> } | null)?.quietHours) ?? {}),
                ...(data.quietHours as Record<string, unknown>),
              },
            }
          : {}),
        ...(data.pacing !== undefined ? { pacing: data.pacing } : {}),
      };
      const parsed = followupConfigSchema.safeParse(merged);
      if (!parsed.success) {
        return { result: JSON.stringify({ ok: false, error: `datos inválidos: ${zodErrorsText(parsed.error)}` }), wrote: false };
      }
      await updateAgentReminders(companyId, (parsed.data ?? null) as Record<string, unknown> | null);
      return { result: JSON.stringify({ ok: true, nota: "Recordatorios actualizados (lo no enviado se conservó)." }), wrote: true };
    }

    // ---------------------- ANÁLISIS (solo lectura) ----------------------
    case "ver_metricas": {
      const stats = await getDashboardStats({
        companyId,
        from: asStr(args.desde),
        to: asStr(args.hasta),
        productId: asStr(args.productId),
      });
      return {
        result: JSON.stringify({
          rango: stats.range,
          moneda: stats.currency,
          kpis: stats.kpis,
          embudo: stats.funnel,
          topProductos: stats.topProducts,
          metodosPago: stats.paymentMethods,
          rendimientoPorAnuncio: stats.adPerformance,
          serie: stats.series,
          nota: "Cada KPI trae {value, prev} = periodo actual vs anterior. rendimientoPorAnuncio agrupa leads/ventas/ingresos/conversión por anuncio Meta de origen (adSourceId null = sin anuncio).",
        }),
        wrote: false,
      };
    }

    case "listar_ventas":
    case "listar_comprobantes": {
      const isVentas = name === "listar_ventas";
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const receipts = await listReceipts(companyId, {
        status: isVentas ? "APROBADO" : (asStr(args.estado) as never) ?? "PENDIENTE",
        from: asStr(args.desde),
        to: asStr(args.hasta),
      });
      const rows = receipts.slice(0, limit).map((r) => ({
        id: r.id,
        fecha: r.occurredAt ?? r.validatedAt ?? r.createdAt,
        monto: r.amountPaid ?? r.amountExpected,
        moneda: r.currency,
        metodo: r.paymentSource,
        estado: r.status,
        validacion: r.validationMode,
        producto: r.product?.name ?? null,
        cliente: { nombre: r.customer?.name ?? r.payerName ?? null, phone: r.customer?.phone ?? r.payerPhone ?? null },
      }));
      return { result: JSON.stringify({ total: receipts.length, mostrados: rows.length, items: rows }), wrote: false };
    }

    case "listar_pedidos": {
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const estado = asStr(args.estado)?.toUpperCase();
      const orders = await listOrders(companyId);
      const filtered = estado ? orders.filter((o) => o.status === estado) : orders;
      const rows = filtered.slice(0, limit).map((o) => ({
        id: o.id,
        codigo: o.orderCode,
        estado: o.status,
        total: o.total,
        pago: o.paymentStatus,
        fecha: o.createdAt,
        cliente: { nombre: o.customer?.name ?? null, phone: o.customer?.phone ?? null },
        items: (o.items ?? []).map((i) => ({ producto: i.productName, cantidad: i.quantity })),
      }));
      return { result: JSON.stringify({ total: filtered.length, mostrados: rows.length, items: rows }), wrote: false };
    }

    case "listar_conversaciones": {
      const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
      const etapa = asStr(args.etapa)?.toUpperCase();
      const convos = await listConversations(companyId, 200);
      const filtered = etapa
        ? convos.filter((c) => (c.funnelStatus ?? "").toUpperCase() === etapa || c.status.toUpperCase() === etapa)
        : convos;
      const rows = filtered.slice(0, limit).map((c) => ({
        phone: c.customer.phone,
        nombre: c.customer.name,
        estado: c.status,
        etapa: c.funnelStatus,
        atencionHumana: c.botPaused ? c.humanReason ?? true : false,
        fijado: Boolean(c.pinnedAt),
        noContactar: Boolean(c.customer.optOutAt),
        ultimoMensaje: c.lastMessage
          ? { rol: c.lastMessage.role, texto: String(c.lastMessage.message ?? "").slice(0, 200), fecha: c.lastMessage.createdAt }
          : null,
      }));
      return { result: JSON.stringify({ total: filtered.length, mostrados: rows.length, items: rows }), wrote: false };
    }

    case "leer_conversacion": {
      const phoneDigits = String(args.phone ?? "").replace(/\D/g, "");
      if (!phoneDigits) return { result: JSON.stringify({ ok: false, error: "phone requerido" }), wrote: false };
      const customer = await prisma.customer.findFirst({
        where: { companyId, phone: { contains: phoneDigits } },
        select: { id: true, name: true, phone: true, metadata: true },
      });
      if (!customer) return { result: JSON.stringify({ ok: false, error: `no encontré un cliente con teléfono ${phoneDigits}` }), wrote: false };
      const flowVarsRaw = (customer.metadata as { flowVars?: Record<string, unknown> } | null)?.flowVars;
      const respuestasDelFlujo = flowVarsRaw && typeof flowVarsRaw === "object"
        ? Object.fromEntries(Object.entries(flowVarsRaw).filter(([k, v]) => !k.startsWith("_") && typeof v === "string"))
        : undefined;
      const convo = await prisma.conversation.findFirst({
        where: { companyId, customerId: customer.id },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true },
      });
      if (!convo) return { result: JSON.stringify({ ok: false, error: "el cliente no tiene conversaciones" }), wrote: false };
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      const messages = await listConversationMessages(companyId, convo.id, limit);
      return {
        result: JSON.stringify({
          cliente: { nombre: customer.name, phone: customer.phone },
          ...(respuestasDelFlujo && Object.keys(respuestasDelFlujo).length ? { respuestasDelFlujo } : {}),
          mensajes: messages.map((m) => ({
            id: m.id,
            rol: m.role,
            texto: String(m.message ?? "").slice(0, 300),
            ...(m.mediaType ? { media: m.mediaType } : {}),
            fecha: m.createdAt,
          })),
          nota: "Para responder como asesor usa enviar_mensaje_cliente (citarMensajeId = id); para reaccionar, reaccionar_mensaje.",
        }),
        wrote: false,
      };
    }

    case "fijar_conversacion": {
      try {
        const ref = await findCustomerRef(companyId, args.cliente);
        const convo = await prisma.conversation.findFirst({
          where: { companyId, customerId: ref.id, channel: { in: ["whatsapp", "web"] } },
          orderBy: { lastMessageAt: "desc" },
          select: { id: true },
        });
        if (!convo) return { result: JSON.stringify({ ok: false, error: "el cliente no tiene conversación" }), wrote: false };
        const fijar = args.fijar !== false;
        await setConversationPinned(companyId, convo.id, fijar);
        return { result: JSON.stringify({ ok: true, fijado: fijar }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no encontrado" }), wrote: false };
      }
    }

    case "enviar_mensaje_cliente": {
      try {
        const mensaje = String(args.mensaje ?? "").trim();
        const mediaUrl = String(args.mediaUrl ?? "").trim();
        if (!mensaje && !mediaUrl) return { result: JSON.stringify({ ok: false, error: "indica mensaje y/o mediaUrl" }), wrote: false };
        if (mediaUrl && !/^https?:\/\/\S+$/i.test(mediaUrl)) return { result: JSON.stringify({ ok: false, error: "mediaUrl debe ser una URL http(s) real (archivo del producto, generar_imagen, listar_recursos o URL pública); nunca un data:URI" }), wrote: false };
        const { customer, convo } = await findChatByRef(companyId, args.phone);
        if (convo.status === "CLOSED") return { result: JSON.stringify({ ok: false, error: "la conversación está cerrada" }), wrote: false };
        const provider = await senderProviderFor(companyId, convo.channel);
        if (!provider) return { result: JSON.stringify({ ok: false, error: "no hay una cuenta de WhatsApp activa para enviar (panel → WhatsApp API)" }), wrote: false };
        const gate = await checkManualSendGate({ companyId, customerId: customer.id, provider, optOutAt: convo.customer.optOutAt });
        if (!gate.ok) return { result: JSON.stringify(gate), wrote: false };

        let tipo: string;
        if (mediaUrl) {
          const kind = mediaKindFromUrl(mediaUrl);
          await sendHumanMedia(
            companyId,
            convo.id,
            { mediaUrl, mediaKind: kind, caption: mensaje || undefined, fileName: args.nombreArchivo ? String(args.nombreArchivo) : undefined },
            { source: COPILOT_SOURCE },
          );
          tipo = kind;
        } else {
          await sendHumanReply(companyId, convo.id, mensaje, {
            quoteMessageId: args.citarMensajeId ? String(args.citarMensajeId) : null,
            source: COPILOT_SOURCE,
          });
          tipo = "text";
        }
        const pausado = args.pasarAHumano === false ? false : await takeControlByCopilot(companyId, convo, args.motivo);
        const atencionHumana = convo.botPaused || pausado;
        return {
          result: JSON.stringify({
            ok: true,
            enviado: { phone: customer.phone, nombre: customer.name, tipo, rol: "ADMIN", canal: convo.channel },
            atencionHumana,
            ritmo: { esperadoSeg: gate.esperadoSeg, enviadosUltimaHora: gate.enviadosUltimaHora + 1, topeHora: gate.topeHora },
            nota: atencionHumana ? NOTA_ATENCION_HUMANA : "El agente IA sigue activo en este chat.",
          }),
          wrote: true,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo enviar" }), wrote: false };
      }
    }

    case "atencion_humana": {
      try {
        const { customer, convo } = await findChatByRef(companyId, args.phone);
        const activar = args.activar === true;
        if (activar) {
          const pausado = await takeControlByCopilot(companyId, convo, args.motivo);
          return {
            result: JSON.stringify({ ok: true, atencionHumana: true, cambio: pausado, cliente: { phone: customer.phone, nombre: customer.name }, nota: pausado ? NOTA_ATENCION_HUMANA : "Ya estaba en atención humana." }),
            wrote: pausado,
          };
        }
        if (!convo.botPaused) {
          return { result: JSON.stringify({ ok: true, atencionHumana: false, cambio: false, nota: "El bot ya estaba activo en este chat." }), wrote: false };
        }
        await setHumanReason(convo.id, "COPILOTO", null);
        await setBotPaused(companyId, convo.id, false);
        return {
          result: JSON.stringify({ ok: true, atencionHumana: false, cambio: true, cliente: { phone: customer.phone, nombre: customer.name }, nota: "Bot reactivado: el agente IA vuelve a responder a este cliente." }),
          wrote: true,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no encontrado" }), wrote: false };
      }
    }

    case "enviar_respuesta_rapida": {
      try {
        const ref = String(args.respuesta ?? "").trim();
        if (!ref) return { result: JSON.stringify({ ok: false, error: "indica la respuesta rápida (id, /comando o título)" }), wrote: false };
        const replies = await listQuickReplies(companyId);
        const refCmd = ref.replace(/^\/+/, "").toLowerCase().replace(/\s+/g, "");
        const refLower = ref.toLowerCase();
        const qr =
          replies.find((r) => r.id === ref) ??
          replies.find((r) => (r.command ?? "").toLowerCase() === refCmd) ??
          replies.find((r) => r.title.trim().toLowerCase() === refLower) ??
          replies.find((r) => r.title.toLowerCase().includes(refLower));
        if (!qr) return { result: JSON.stringify({ ok: false, error: `no encontré la respuesta rápida «${ref}»`, disponibles: replies.slice(0, 20).map((r) => ({ id: r.id, titulo: r.title, comando: r.command ? `/${r.command}` : null })) }), wrote: false };
        const { customer, convo } = await findChatByRef(companyId, args.phone);
        if (convo.channel === "web") return { result: JSON.stringify({ ok: false, error: "las respuestas rápidas solo salen por WhatsApp; en chat web usa enviar_mensaje_cliente" }), wrote: false };
        const provider = await senderProviderFor(companyId, convo.channel);
        if (!provider) return { result: JSON.stringify({ ok: false, error: "no hay una cuenta de WhatsApp activa para enviar (panel → WhatsApp API)" }), wrote: false };
        const gate = await checkManualSendGate({ companyId, customerId: customer.id, provider, optOutAt: convo.customer.optOutAt });
        if (!gate.ok) return { result: JSON.stringify(gate), wrote: false };
        const tomarControl = args.tomarControl !== false;
        if (tomarControl) await setHumanReason(convo.id, "COPILOTO", `Respuesta rápida «${qr.title}» enviada por el copiloto`);
        const r = await sendQuickReply(companyId, qr.id, convo.id, tomarControl);
        // Marcar el origen para el ritmo anti-bloqueo (sendQuickReply guarda ADMIN sin rawPayload).
        await prisma.conversationMessage.updateMany({
          where: { companyId, conversationId: convo.id, role: "ADMIN", rawPayload: { equals: Prisma.DbNull }, createdAt: { gte: new Date(Date.now() - 5 * 60_000) } },
          data: { rawPayload: { source: COPILOT_SOURCE } },
        }).catch(() => undefined);
        const atencionHumana = convo.botPaused || tomarControl;
        return {
          result: JSON.stringify({
            ok: true,
            respuesta: { id: qr.id, titulo: qr.title, comando: qr.command ? `/${qr.command}` : null },
            enviados: r.sentCount,
            total: r.total,
            ...(r.failedAtIndex !== undefined ? { falloEnMensaje: r.failedAtIndex + 1 } : {}),
            cliente: { phone: customer.phone, nombre: customer.name },
            atencionHumana,
            ritmo: { esperadoSeg: gate.esperadoSeg, enviadosUltimaHora: gate.enviadosUltimaHora + r.sentCount, topeHora: gate.topeHora },
            nota: atencionHumana ? NOTA_ATENCION_HUMANA : "El agente IA sigue activo en este chat.",
          }),
          wrote: true,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo enviar" }), wrote: false };
      }
    }

    case "reaccionar_mensaje": {
      try {
        const mensajeId = String(args.mensajeId ?? "").trim();
        if (!mensajeId) return { result: JSON.stringify({ ok: false, error: "mensajeId requerido (de leer_conversacion)" }), wrote: false };
        const { convo } = await findChatByRef(companyId, args.phone);
        const emoji = String(args.emoji ?? "");
        await reactToMessage(companyId, convo.id, mensajeId, emoji);
        return { result: JSON.stringify({ ok: true, mensajeId, reaccion: emoji.trim() || null }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo reaccionar" }), wrote: false };
      }
    }

    case "programar_recordatorio_cliente": {
      try {
        const mensaje = String(args.mensaje ?? "").trim();
        const mediaUrl = args.mediaUrl ? String(args.mediaUrl).trim() : null;
        if (mediaUrl && !/^https?:\/\/\S+$/i.test(mediaUrl)) return { result: JSON.stringify({ ok: false, error: "mediaUrl debe ser una URL http(s) real" }), wrote: false };
        let sendAt: Date;
        if (args.enviarEn) sendAt = new Date(String(args.enviarEn));
        else if (args.enMinutos != null && Number.isFinite(Number(args.enMinutos))) sendAt = new Date(Date.now() + Number(args.enMinutos) * 60_000);
        else return { result: JSON.stringify({ ok: false, error: "indica enviarEn (ISO) o enMinutos" }), wrote: false };
        if (isNaN(sendAt.getTime())) return { result: JSON.stringify({ ok: false, error: "enviarEn no es una fecha válida (usa ISO, ej. 2026-10-28T18:30:00-05:00)" }), wrote: false };
        const { customer, convo } = await findChatByRef(companyId, args.phone);
        if (convo.customer.optOutAt) return { result: JSON.stringify({ ok: false, error: "el cliente pidió no ser contactado (noContactar)" }), wrote: false };
        if (convo.channel === "web") return { result: JSON.stringify({ ok: false, error: "el chat web no admite recordatorios programados" }), wrote: false };
        await scheduleManualReminder(companyId, convo.id, {
          message: mensaje,
          sendAt,
          mediaUrl,
          mediaType: mediaUrl ? mediaKindFromUrl(mediaUrl, args.mediaType) : null,
        });
        return {
          result: JSON.stringify({
            ok: true,
            cliente: { phone: customer.phone, nombre: customer.name },
            enviaEl: sendAt.toISOString(),
            nota: "Si cae fuera del horario hábil del negocio, el sistema lo mueve a la apertura. Se ve en listar_recordatorios_programados y se cancela con cancelar_recordatorios o desde el chat del panel.",
          }),
          wrote: true,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo programar" }), wrote: false };
      }
    }

    case "iniciar_conversacion": {
      try {
        const phone = String(args.phone ?? "").trim();
        const mensaje = String(args.mensaje ?? "").trim();
        if (!phone || !mensaje) return { result: JSON.stringify({ ok: false, error: "phone y mensaje son requeridos" }), wrote: false };
        const digits = phone.replace(/\D/g, "");
        if (digits.length < 8) return { result: JSON.stringify({ ok: false, error: "número inválido (incluye el código de país, ej. 51999888777)" }), wrote: false };
        const existing = await prisma.customer.findFirst({ where: { companyId, phone: `+${digits}` }, select: { id: true, name: true, optOutAt: true } });
        const sender = await loadWhatsappSender(companyId);
        if (!sender) return { result: JSON.stringify({ ok: false, error: "no hay una cuenta de WhatsApp activa para enviar (panel → WhatsApp API)" }), wrote: false };
        if (existing) {
          const convo = await prisma.conversation.findFirst({ where: { companyId, customerId: existing.id, channel: "whatsapp" }, select: { id: true } });
          if (convo) return { result: JSON.stringify({ ok: false, error: `${existing.name ?? phone} ya tiene conversación: usa enviar_mensaje_cliente` }), wrote: false };
        }
        // Número nuevo en META: nunca escribió → fuera de la ventana de 24 h (la compuerta lo rechaza).
        const gate = await checkManualSendGate({ companyId, customerId: existing?.id ?? null, provider: sender.provider, optOutAt: existing?.optOutAt ?? null });
        if (!gate.ok) return { result: JSON.stringify(gate), wrote: false };
        if (sender.provider === "META" && !existing) {
          return { result: JSON.stringify({ ok: false, error: "con WhatsApp Meta no se puede escribir primero a un número que nunca escribió (ventana de 24 h); usa una campaña con plantilla aprobada" }), wrote: false };
        }
        const r = await startConversation(companyId, phone, mensaje, { source: COPILOT_SOURCE });
        return {
          result: JSON.stringify({ ok: true, conversacionId: r.conversationId, phone: `+${digits}`, ritmo: { esperadoSeg: gate.esperadoSeg, enviadosUltimaHora: gate.enviadosUltimaHora + 1, topeHora: gate.topeHora }, nota: "El bot sigue activo: si el cliente responde, el agente IA continúa. Para atenderlo tú, atencion_humana {activar:true}." }),
          wrote: true,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo iniciar" }), wrote: false };
      }
    }

    case "reiniciar_conversacion": {
      try {
        const { customer, convo } = await findChatByRef(companyId, args.phone);
        await resetConversation(companyId, convo.id, customer.id);
        await cancelPendingReminders(companyId, customer.id, [
          ScheduledMessageType.ABANDONED_CART,
          ScheduledMessageType.LEFT_ON_READ,
          ScheduledMessageType.OFFER_COUNTDOWN,
          ScheduledMessageType.POST_SALE,
          ScheduledMessageType.CUSTOM,
        ]);
        return { result: JSON.stringify({ ok: true, cliente: { phone: customer.phone, nombre: customer.name }, nota: "Historial y carrito borrados, estado limpio, bot activo. El cliente no recibió nada." }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo reiniciar" }), wrote: false };
      }
    }

    case "ver_cliente": {
      try {
        const ref = await findCustomerRef(companyId, args.cliente);
        const [c, notes] = await Promise.all([getCustomer(companyId, ref.id), listNotes(companyId, ref.id)]);
        return {
          result: JSON.stringify({
            cliente: { ...c, noContactar: Boolean((c as { optOutAt?: Date | null }).optOutAt) },
            notas: notes.map((n) => ({ id: n.id, texto: n.text, fecha: n.createdAt })),
          }),
          wrote: false,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no encontrado" }), wrote: false };
      }
    }

    case "actualizar_cliente": {
      try {
        const ref = await findCustomerRef(companyId, args.cliente);
        const d = (args.data ?? {}) as LooseData;
        const data = {
          ...(d.phone !== undefined ? { phone: String(d.phone) } : {}),
          ...(d.name !== undefined ? { name: asStr(d.name) ?? null } : {}),
          ...(d.email !== undefined ? { email: asStr(d.email) ?? null } : {}),
          ...(d.sexo !== undefined ? { sexo: asStr(d.sexo) ?? null } : {}),
          ...(d.fechaNacimiento !== undefined ? { fechaNacimiento: asStr(d.fechaNacimiento) ?? null } : {}),
          ...(d.idioma !== undefined ? { idioma: asStr(d.idioma) ?? null } : {}),
          ...(d.origenDeLead !== undefined ? { origenDeLead: asStr(d.origenDeLead) ?? null } : {}),
        };
        let optOutNote: Record<string, unknown> = {};
        if (typeof d.noContactar === "boolean") {
          const r = await setCustomerOptOut(companyId, ref.id, d.noContactar, { pauseBot: true, reason: "marcado por el dueño (copiloto)" });
          optOutNote = { noContactar: d.noContactar, recordatoriosCancelados: r.cancelled };
        }
        if (!Object.keys(data).length) {
          if (!Object.keys(optOutNote).length) return { result: JSON.stringify({ ok: false, error: "nada que cambiar" }), wrote: false };
          return { result: JSON.stringify({ ok: true, ...optOutNote }), wrote: true };
        }
        const u = await updateCustomer(companyId, ref.id, data);
        return { result: JSON.stringify({ ok: true, cliente: { id: u.id, name: u.name, phone: u.phone, email: u.email }, ...optOutNote }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo actualizar" }), wrote: false };
      }
    }

    case "agregar_nota_cliente": {
      try {
        const ref = await findCustomerRef(companyId, args.cliente);
        const n = await createNote(companyId, ref.id, { text: asStr(args.texto) ?? "" });
        return { result: JSON.stringify({ ok: true, notaId: n.id }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo guardar" }), wrote: false };
      }
    }

    case "eliminar_cliente": {
      try {
        const ref = await findCustomerRef(companyId, args.cliente);
        await deleteCustomer(companyId, ref.id);
        return { result: JSON.stringify({ ok: true, eliminado: ref.name ?? ref.phone }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo eliminar" }), wrote: false };
      }
    }

    case "actualizar_pedido": {
      const codigo = asStr(args.codigo) ?? "";
      const estado = (asStr(args.estado) ?? "").toUpperCase() as OrderStatus;
      const VALID: OrderStatus[] = ["PEDIDO_REGISTRADO", "EN_COORDINACION", "DESPACHADO", "CANCELADO", "PENDIENTE_PAGO", "PAGADO", "ENTREGADO"];
      if (!VALID.includes(estado)) return { result: JSON.stringify({ ok: false, error: `estado inválido; usa ${VALID.join(" | ")}` }), wrote: false };
      const order = await prisma.order.findFirst({ where: { companyId, OR: [{ id: /^[0-9a-f-]{36}$/i.test(codigo) ? codigo : "00000000-0000-0000-0000-000000000000" }, { orderCode: codigo }] }, select: { id: true, orderCode: true } });
      if (!order) return { result: JSON.stringify({ ok: false, error: `pedido «${codigo}» no encontrado` }), wrote: false };
      try {
        const u = await updateOrderStatus(companyId, order.id, estado, { note: asStr(args.nota) ?? null, changedBy: "copiloto" });
        return { result: JSON.stringify({ ok: true, codigo: order.orderCode, estado: (u as { status?: string }).status ?? estado }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo actualizar" }), wrote: false };
      }
    }

    case "crear_cita": {
      try {
        const ref = await findCustomerRef(companyId, args.cliente);
        const sref = asStr(args.servicio) ?? "";
        const products = await prisma.product.findMany({ where: { companyId, active: true }, select: { id: true, name: true } });
        const p = products.find((x) => x.id === sref || x.name.trim().toLowerCase() === sref.trim().toLowerCase());
        if (!p) return { result: JSON.stringify({ ok: false, error: `servicio «${sref}» no encontrado` }), wrote: false };
        const b = await createBooking({ companyId, customerId: ref.id, productId: p.id, startsAt: asStr(args.inicio) ?? null, modality: asStr(args.modalidad) ?? null, notes: asStr(args.notas) ?? null, source: "copiloto" });
        return { result: JSON.stringify({ ok: true, cita: { codigo: (b as { bookingCode?: string }).bookingCode ?? null, estado: (b as { status?: string }).status ?? null, inicio: (b as { startsAt?: Date | null }).startsAt ?? null, calendario: (b as { calendar?: unknown }).calendar ?? null } }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo crear" }), wrote: false };
      }
    }

    case "actualizar_cita": {
      const codigo = asStr(args.codigo) ?? "";
      const booking = await prisma.serviceBooking.findFirst({ where: { companyId, OR: [{ id: /^[0-9a-f-]{36}$/i.test(codigo) ? codigo : "00000000-0000-0000-0000-000000000000" }, { bookingCode: codigo }] }, select: { id: true, bookingCode: true } });
      if (!booking) return { result: JSON.stringify({ ok: false, error: `cita «${codigo}» no encontrada` }), wrote: false };
      try {
        const inicio = asStr(args.inicio);
        if (inicio) await rescheduleBooking(companyId, booking.id, inicio);
        const estado = (asStr(args.estado) ?? "").toUpperCase() as ServiceBookingStatus;
        const VALID: ServiceBookingStatus[] = ["SOLICITADA", "CONFIRMADA", "CANCELADA", "COMPLETADA"];
        if (estado) {
          if (!VALID.includes(estado)) return { result: JSON.stringify({ ok: false, error: `estado inválido; usa ${VALID.join(" | ")}` }), wrote: false };
          await updateBookingStatus(companyId, booking.id, estado);
        }
        if (!inicio && !estado) return { result: JSON.stringify({ ok: false, error: "indica estado o inicio" }), wrote: false };
        return { result: JSON.stringify({ ok: true, codigo: booking.bookingCode }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo actualizar" }), wrote: false };
      }
    }

    case "bloquear_horario": {
      try {
        if (args.listar === true) {
          const blocks = await listScheduleBlocks(companyId);
          return { result: JSON.stringify({ bloqueos: blocks }), wrote: false };
        }
        const quitar = asStr(args.quitarId);
        if (quitar) {
          await deleteScheduleBlock(companyId, quitar);
          return { result: JSON.stringify({ ok: true, eliminado: quitar }), wrote: true };
        }
        const inicio = asStr(args.inicio); const fin = asStr(args.fin);
        if (!inicio || !fin) return { result: JSON.stringify({ ok: false, error: "indica inicio y fin (ISO), o listar=true, o quitarId" }), wrote: false };
        const b = await createScheduleBlock(companyId, { startsAt: inicio, endsAt: fin, reason: asStr(args.motivo) ?? null });
        return { result: JSON.stringify({ ok: true, bloqueo: b }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo bloquear" }), wrote: false };
      }
    }

    case "listar_citas": {
      const bookings = await listBookings(companyId, {
        status: asStr(args.estado)?.toUpperCase() as never,
        from: args.desde ? new Date(String(args.desde)) : undefined,
        to: args.hasta ? new Date(String(args.hasta)) : undefined,
      });
      const rows = bookings.slice(0, 100).map((b) => ({
        id: b.id,
        codigo: b.bookingCode,
        estado: b.status,
        inicio: b.startsAt,
        fin: b.endsAt,
        servicio: b.product?.name ?? null,
        cliente: { nombre: b.customer?.name ?? null, phone: b.customer?.phone ?? null },
      }));
      return { result: JSON.stringify({ total: bookings.length, mostrados: rows.length, items: rows }), wrote: false };
    }

    case "ver_catalogo_anuncios": {
      const entries = await listAdCatalog(companyId);
      const [tags, boards, columns] = await Promise.all([
        prisma.customerTag.findMany({ where: { companyId }, select: { id: true, name: true } }),
        prisma.crm.findMany({ where: { companyId }, select: { id: true, name: true } }),
        prisma.crmColumn.findMany({ where: { crm: { companyId } }, select: { id: true, name: true } }),
      ]);
      const nameOf = (list: { id: string; name: string }[], id: string | null | undefined) => (id ? list.find((x) => x.id === id)?.name ?? null : null);
      return {
        result: JSON.stringify({
          total: entries.length,
          items: entries.map((e) => ({
            id: e.id,
            description: e.description,
            matchers: e.matchers,
            producto: e.product?.name ?? null,
            etiquetas: (e.tagIds ?? []).map((id) => nameOf(tags, id)).filter(Boolean),
            tablero: nameOf(boards, e.crmId),
            columna: nameOf(columns, e.crmColumnId),
          })),
          nota: "etiquetas/tablero/columna se aplican al lead con su PRIMER mensaje desde ese anuncio; los flujos pueden dispararse con trigger onAdLead.",
        }),
        wrote: false,
      };
    }

    case "configurar_anuncio": {
      const id = asStr(args.id);
      if (args.eliminar === true) {
        if (!id) return { result: JSON.stringify({ ok: false, error: "falta id para eliminar" }), wrote: false };
        await deleteAdCatalogEntry(companyId, id);
        return { result: JSON.stringify({ ok: true, nota: "Entrada del catálogo eliminada." }), wrote: true };
      }
      // Vínculo a producto: por productId directo (infalible) o por nombre con
      // match TOLERANTE — los nombres guardados pueden traer espacios al inicio
      // o dobles espacios (el equals exacto fallaba sin salida para el modelo).
      let productId: string | null | undefined;
      if (asStr(args.productId)?.trim()) {
        const pid = asStr(args.productId)!.trim();
        const product = await prisma.product.findFirst({ where: { id: pid, companyId }, select: { id: true } });
        if (!product) {
          return { result: JSON.stringify({ ok: false, error: "productId no encontrado; usa un id de listar_productos" }), wrote: false };
        }
        productId = product.id;
      } else if (args.productName !== undefined) {
        const name = String(args.productName ?? "").trim();
        if (!name) {
          productId = null;
        } else {
          const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
          const wanted = norm(name);
          const products = await prisma.product.findMany({
            where: { companyId },
            select: { id: true, name: true },
            take: 300,
          });
          let matches = products.filter((p) => norm(p.name) === wanted);
          if (!matches.length) matches = products.filter((p) => norm(p.name).includes(wanted));
          if (matches.length === 1) {
            productId = matches[0].id;
          } else {
            return {
              result: JSON.stringify({
                ok: false,
                error: matches.length
                  ? `varios productos coinciden con "${name}" — usa productId de listar_productos`
                  : `no encontré un producto que coincida con "${name}" — usa productId de listar_productos`,
                productosDisponibles: products.map((p) => ({ id: p.id, name: p.name })),
              }),
              wrote: false,
            };
          }
        }
      }
      const matchers = asStrList(args.matchers);
      // Acciones CRM al llegar: etiquetas (nombres/ids; []/null quita) y tablero+columna (null quita).
      let crmActions: { tagIds?: string[]; crmId?: string | null; crmColumnId?: string | null } = {};
      try {
        if (args.etiquetas !== undefined) crmActions.tagIds = args.etiquetas === null ? [] : (await tagIdsByName(companyId, args.etiquetas)) ?? [];
        if (args.tablero === null || args.columna === null) crmActions = { ...crmActions, crmId: null, crmColumnId: null };
        else if (args.tablero !== undefined || args.columna !== undefined) {
          const bc = await resolveBoardColumn(companyId, asStr(args.tablero), asStr(args.columna));
          crmActions = { ...crmActions, crmId: bc.crmId, crmColumnId: bc.crmColumnId };
        }
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "acciones CRM inválidas" }), wrote: false };
      }
      const entryOut = (e: Awaited<ReturnType<typeof createAdCatalogEntry>>) => ({
        id: e.id,
        description: e.description,
        matchers: e.matchers,
        producto: e.product?.name ?? null,
        etiquetas: e.tagIds?.length ?? 0,
        tablero: e.crmId ?? null,
        columna: e.crmColumnId ?? null,
      });
      if (id) {
        const updated = await updateAdCatalogEntry(companyId, id, {
          ...(args.description !== undefined ? { description: String(args.description) } : {}),
          ...(matchers ? { matchers } : {}),
          ...(productId !== undefined ? { productId } : {}),
          ...crmActions,
        });
        return { result: JSON.stringify({ ok: true, entry: entryOut(updated), nota: "ver_catalogo_anuncios muestra etiquetas/columna con nombres." }), wrote: true };
      }
      const created = await createAdCatalogEntry(companyId, {
        description: String(args.description ?? ""),
        matchers: matchers ?? [],
        ...(productId !== undefined ? { productId } : {}),
        ...crmActions,
      });
      return { result: JSON.stringify({ ok: true, entry: entryOut(created), nota: "ver_catalogo_anuncios muestra etiquetas/columna con nombres." }), wrote: true };
    }

    case "listar_campanas": {
      const campaigns = await listCampaigns(companyId);
      return { result: JSON.stringify({ total: campaigns.length, items: campaigns }), wrote: false };
    }

    case "crear_campana": {
      const name = String(args.name ?? "").trim();
      if (!name) return { result: JSON.stringify({ ok: false, error: "falta el nombre de la campaña" }), wrote: false };
      const rawMsgs = Array.isArray(args.mensajes) ? args.mensajes : [];
      const VALID_TYPES = new Set(["text", "image", "video", "audio", "document"]);
      const messages: CampaignMessageItem[] = rawMsgs
        .map((m) => {
          const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
          const type = VALID_TYPES.has(String(o.type ?? "")) ? (String(o.type) as CampaignMessageItem["type"]) : "text";
          return { type, text: asStr(o.text) ?? undefined, mediaUrl: asStr(o.mediaUrl) ?? undefined };
        })
        .filter((m) => m.text || m.mediaUrl)
        .slice(0, 10);
      if (!messages.length) {
        return { result: JSON.stringify({ ok: false, error: "la campaña necesita al menos un mensaje (text o mediaUrl)" }), wrote: false };
      }
      const recipients = await resolveCampaignAudience(companyId, (args.audiencia ?? {}) as Record<string, unknown>);
      if (!recipients.length) {
        return {
          result: JSON.stringify({
            ok: false,
            error:
              "La audiencia quedó vacía. Revisa los filtros (tagIds reales de ver_crm, funnelStatus NUEVO|INTERESADO|ESPERANDO_PAGO|PAGADO|ENTREGADO, adSourceId del catálogo de anuncios) o pasa phones explícitos.",
          }),
          wrote: false,
        };
      }
      const cfg = parseSendConfig({ ...DEFAULT_SEND_CONFIG, ...((args.sendConfig && typeof args.sendConfig === "object" ? args.sendConfig : {}) as Record<string, unknown>) });
      try {
        const actions: CampaignAction[] = Array.isArray(args.pasos) && args.pasos.length
          ? await resolveCampaignSteps(companyId, args.pasos, messages)
          : [{ type: "send-message", messages }];
        const ctxTags = (await tagIdsByName(companyId, args.etiquetasContexto)) ?? (Array.isArray(args.contextTagIds) ? args.contextTagIds.map((t) => String(t)).filter(Boolean) : undefined);
        const ctxRemove = await tagIdsByName(companyId, args.quitarEtiquetasContexto);
        const created = await createCampaign(companyId, { name });
        await updateCampaign(companyId, created.id, {
          actions,
          sendConfig: cfg,
          audience: { recipients },
          ...(args.contextProductId !== undefined ? { contextProductId: asStr(args.contextProductId) ?? null } : {}),
          ...(ctxTags ? { contextTagIds: ctxTags } : {}),
          ...(ctxRemove ? { contextRemoveTagIds: ctxRemove } : {}),
        });
        return {
          result: JSON.stringify({
            ok: true,
            campaignId: created.id,
            estado: "BORRADOR",
            totalContactos: recipients.length,
            resumenDeEnvio: describeSendPlan(cfg, recipients.length, actions),
            nota:
              "Campaña creada EN BORRADOR: aún NO envía nada. Muéstrale al usuario el total de contactos y el resumen; recomiéndale una prueba con enviar_prueba_campana a su propio número, y lanza con iniciar_campana SOLO cuando él confirme explícitamente.",
          }),
          wrote: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "no se pudo crear la campaña";
        return { result: JSON.stringify({ ok: false, error: message }), wrote: false };
      }
    }

    case "actualizar_campana": {
      const campaignId = asStr(args.campaignId) ?? "";
      const data = (args.data ?? {}) as LooseData;
      if (!campaignId) return { result: JSON.stringify({ ok: false, error: "falta campaignId" }), wrote: false };
      try {
        const current = (await listCampaigns(companyId)).find((c) => c.id === campaignId);
        if (!current) return { result: JSON.stringify({ ok: false, error: "campaña no encontrada" }), wrote: false };
        const patch: Parameters<typeof updateCampaign>[2] = {};
        if (asStr(data.name)) patch.name = asStr(data.name) as string;
        if (Array.isArray(data.pasos) && data.pasos.length) patch.actions = await resolveCampaignSteps(companyId, data.pasos, []);
        if (data.audiencia && typeof data.audiencia === "object") {
          const recipients = await resolveCampaignAudience(companyId, data.audiencia as Record<string, unknown>);
          if (!recipients.length) return { result: JSON.stringify({ ok: false, error: "La audiencia quedó vacía." }), wrote: false };
          patch.audience = { recipients };
        }
        if (data.sendConfig && typeof data.sendConfig === "object") patch.sendConfig = parseSendConfig({ ...((current as { sendConfig?: Record<string, unknown> }).sendConfig ?? {}), ...(data.sendConfig as Record<string, unknown>) });
        if (data.contextProductId !== undefined) patch.contextProductId = asStr(data.contextProductId) ?? null;
        const ctxTags = await tagIdsByName(companyId, data.etiquetasContexto);
        if (ctxTags) patch.contextTagIds = ctxTags;
        const ctxRemove = await tagIdsByName(companyId, data.quitarEtiquetasContexto);
        if (ctxRemove) patch.contextRemoveTagIds = ctxRemove;
        const updated = await updateCampaign(companyId, campaignId, patch);
        return { result: JSON.stringify({ ok: true, campaignId: updated.id, estado: updated.status, nota: "Campaña actualizada (lo no enviado se conservó)." }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo actualizar" }), wrote: false };
      }
    }

    case "eliminar_campana": {
      const campaignId = asStr(args.campaignId) ?? "";
      if (!campaignId) return { result: JSON.stringify({ ok: false, error: "falta campaignId" }), wrote: false };
      try {
        await deleteCampaign(companyId, campaignId);
        return { result: JSON.stringify({ ok: true }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo eliminar" }), wrote: false };
      }
    }

    case "aprobar_comprobante":
    case "asociar_comprobante": {
      const receiptId = asStr(args.receiptId) ?? "";
      if (!receiptId) return { result: JSON.stringify({ ok: false, error: "falta receiptId" }), wrote: false };
      let productId: string | null = null;
      const prodRef = asStr(args.producto);
      if (prodRef) {
        const products = await prisma.product.findMany({ where: { companyId }, select: { id: true, name: true } });
        const p = products.find((x) => x.id === prodRef || x.name.trim().toLowerCase() === prodRef.trim().toLowerCase());
        if (!p) return { result: JSON.stringify({ ok: false, error: `producto «${prodRef}» no encontrado` }), wrote: false };
        productId = p.id;
      }
      const phone = asStr(args.telefonoPagador)?.replace(/\D/g, "") || null;
      try {
        const r = name === "aprobar_comprobante" ? await approveReceipt(companyId, receiptId, productId, phone) : await associateReceiptProduct(companyId, receiptId, productId, phone);
        return { result: JSON.stringify({ ok: true, estado: (r as { status?: string }).status ?? null, nota: name === "aprobar_comprobante" ? "Comprobante aprobado: cuenta como venta y dispara la entrega configurada." : "Comprobante asociado." }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo procesar" }), wrote: false };
      }
    }

    case "rechazar_comprobante":
    case "ignorar_comprobante": {
      const receiptId = asStr(args.receiptId) ?? "";
      if (!receiptId) return { result: JSON.stringify({ ok: false, error: "falta receiptId" }), wrote: false };
      try {
        const r = name === "rechazar_comprobante" ? await rejectReceipt(companyId, receiptId, asStr(args.motivo) ?? "rechazado por el dueño") : await ignoreReceipt(companyId, receiptId);
        return { result: JSON.stringify({ ok: true, estado: (r as { status?: string }).status ?? null }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo procesar" }), wrote: false };
      }
    }

    case "enviar_prueba_campana": {
      const phone = String(args.phone ?? "").replace(/\D/g, "");
      if (phone.length < 8) return { result: JSON.stringify({ ok: false, error: "teléfono de prueba inválido" }), wrote: false };
      try {
        await testCampaign(companyId, String(args.campaignId ?? ""), phone);
        return {
          result: JSON.stringify({ ok: true, nota: `Prueba enviada a ${phone}. Pide al usuario verificar cómo llegó antes de lanzar.` }),
          wrote: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "no se pudo enviar la prueba";
        return { result: JSON.stringify({ ok: false, error: message }), wrote: false };
      }
    }

    case "iniciar_campana": {
      try {
        const started = await startCampaign(companyId, String(args.campaignId ?? ""));
        return {
          result: JSON.stringify({
            ok: true,
            estado: started?.status ?? "RUNNING",
            totalContactos: started?.totalCount ?? undefined,
            nota: "Campaña LANZADA: el envío masivo está en curso. El progreso en vivo se ve en el panel (Campañas).",
          }),
          wrote: true,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "no se pudo iniciar la campaña";
        return { result: JSON.stringify({ ok: false, error: message }), wrote: false };
      }
    }

    case "previsualizar_audiencia_campana": {
      const audiencia = (args.audiencia && typeof args.audiencia === "object" ? args.audiencia : {}) as Record<string, unknown>;
      const excludeMuted = typeof args.excludeMuted === "boolean" ? args.excludeMuted : true;
      const raw = await resolveCampaignAudience(companyId, audiencia);
      const { recipients, excluded } = filterAudience(raw, await buildExclusionSets(companyId, excludeMuted));
      return {
        result: JSON.stringify({
          totalSeleccionados: raw.length,
          totalQueRecibiran: recipients.length,
          excluidos: { noContactar: excluded.optOut, atencionHumana: excluded.muted, duplicados: excluded.duplicates, invalidos: excluded.invalid },
          muestra: recipients.slice(0, 10).map((r) => ({ phone: r.phone, name: r.name ?? null })),
          nota: recipients.length ? "Muestra el total al dueño antes de crear_campana." : "Nadie recibiría la campaña: revisa los filtros.",
        }),
        wrote: false,
      };
    }

    case "ver_campana": {
      const campaignId = asStr(args.campaignId) ?? "";
      if (!campaignId) return { result: JSON.stringify({ ok: false, error: "falta campaignId" }), wrote: false };
      try {
        const c = await getCampaign(companyId, campaignId);
        const recipients = await listRecipients(companyId, campaignId);
        const pending = recipients.filter((r) => r.status === "PENDING" || r.status === "SENDING").length;
        const failed = recipients.filter((r) => r.status === "FAILED").slice(-10).map((r) => ({ phone: r.phone, motivo: r.error }));
        const sent24h = recipients.filter((r) => r.status === "SENT" && r.sentAt && Date.now() - new Date(r.sentAt).getTime() < 86_400_000).length;
        return {
          result: JSON.stringify({
            campaignId: c.id,
            nombre: c.name,
            estado: c.status,
            situacion: describePauseReason(c.status, c.pauseReason, c.nextSendAt),
            progreso: { total: c.totalCount, enviados: c.sentCount, fallidos: c.failedCount, pendientes: pending, enviadosUltimas24h: sent24h },
            pasos: await describeCampaignSteps(companyId, c.actions),
            ritmo: c.sendConfig,
            resumenDeEnvio: describeSendPlan(c.sendConfig, c.status === "DRAFT" ? c.audience.recipients.length : pending, c.actions),
            contactosEnBorrador: c.status === "DRAFT" ? c.audience.recipients.length : undefined,
            ultimosFallidos: failed,
            inicio: c.startedAt,
            fin: c.completedAt,
          }),
          wrote: false,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo leer la campaña" }), wrote: false };
      }
    }

    case "pausar_campana":
    case "reanudar_campana":
    case "cancelar_campana": {
      const campaignId = asStr(args.campaignId) ?? "";
      if (!campaignId) return { result: JSON.stringify({ ok: false, error: "falta campaignId" }), wrote: false };
      try {
        const c =
          name === "pausar_campana" ? await pauseCampaign(companyId, campaignId)
          : name === "reanudar_campana" ? await resumeCampaign(companyId, campaignId)
          : await cancelCampaign(companyId, campaignId);
        const pending = Math.max(0, c.totalCount - c.sentCount - c.failedCount);
        const nota =
          name === "pausar_campana" ? `Campaña pausada: quedan ${pending} contacto(s) sin enviar. reanudar_campana para continuar.`
          : name === "reanudar_campana" ? `Campaña reanudada: continúa con ${pending} contacto(s) pendiente(s). ${describeSendPlan(c.sendConfig, pending, c.actions)}`
          : `Campaña cancelada: ${pending} contacto(s) NO recibirán el mensaje; lo enviado (${c.sentCount}) queda.`;
        return { result: JSON.stringify({ ok: true, estado: c.status, enviados: c.sentCount, fallidos: c.failedCount, pendientes: pending, nota }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo cambiar el estado" }), wrote: false };
      }
    }

    case "gestionar_suscripcion": {
      const accion = asStr(args.accion) ?? "";
      try {
        if (accion === "crear") {
          const ref = await findCustomerRef(companyId, args.cliente);
          const pref = asStr(args.producto) ?? "";
          const products = await prisma.product.findMany({ where: { companyId }, select: { id: true, name: true } });
          const p = products.find((x) => x.id === pref || x.name.trim().toLowerCase() === pref.trim().toLowerCase());
          const sub = await createSubscription(companyId, {
            customerId: ref.id,
            productId: p?.id ?? null,
            productName: p?.name ?? (pref || null),
            planLabel: asStr(args.plan) ?? null,
            expiresAt: asStr(args.vence) ?? null,
            durationDays: Number(args.duracionDias) || null,
            amount: asStr(args.monto) ?? null,
            note: asStr(args.nota) ?? null,
            source: "MANUAL",
          });
          return { result: JSON.stringify({ ok: true, subscriptionId: (sub as { id?: string }).id ?? null, vence: (sub as { expiresAt?: Date | null }).expiresAt ?? null }), wrote: true };
        }
        const id = asStr(args.subscriptionId) ?? "";
        if (!id) return { result: JSON.stringify({ ok: false, error: "falta subscriptionId" }), wrote: false };
        if (accion === "renovar") { const r = await markRenewed(companyId, id); return { result: JSON.stringify({ ok: true, vence: (r as { expiresAt?: Date | null }).expiresAt ?? null }), wrote: true }; }
        if (accion === "cancelar") { await markCancelled(companyId, id); return { result: JSON.stringify({ ok: true }), wrote: true }; }
        return { result: JSON.stringify({ ok: false, error: "accion inválida: crear | renovar | cancelar" }), wrote: false };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo procesar" }), wrote: false };
      }
    }

    case "ver_inventario_streaming": {
      const productId = asStr(args.productId);
      const [stats, products] = await Promise.all([credentialStats(companyId), prisma.product.findMany({ where: { companyId }, select: { id: true, name: true } })]);
      const resumen = Object.entries(stats).map(([pid, st]) => ({ productId: pid, producto: products.find((p) => p.id === pid)?.name ?? pid, ...st }));
      const mask = (v: string | null | undefined) => (v ? `${v.slice(0, 2)}…${v.slice(-1)}` : null);
      const items = productId ? (await listCredentials(companyId, productId)).map((c) => ({ id: c.id, estado: c.status, perfil: c.optionLabel, email: c.email, usuario: c.username, password: mask(c.password), profileName: c.profileName, pin: mask(c.pin), nota: c.note })) : undefined;
      return { result: JSON.stringify({ resumen, ...(items ? { items } : {}) }), wrote: false };
    }

    case "actualizar_inventario_streaming": {
      const accion = asStr(args.accion) ?? "";
      try {
        if (accion === "agregar") {
          const pref = asStr(args.producto) ?? "";
          const products = await prisma.product.findMany({ where: { companyId }, select: { id: true, name: true } });
          const p = products.find((x) => x.id === pref || x.name.trim().toLowerCase() === pref.trim().toLowerCase());
          if (!p) return { result: JSON.stringify({ ok: false, error: `producto «${pref}» no encontrado` }), wrote: false };
          const items = (Array.isArray(args.items) ? args.items : []).map((it) => {
            const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
            return { optionLabel: asStr(o.optionLabel) ?? null, email: asStr(o.email) ?? null, username: asStr(o.username) ?? null, password: asStr(o.password) ?? null, profileName: asStr(o.profileName) ?? null, pin: asStr(o.pin) ?? null, extra: asStr(o.extra) ?? null, note: asStr(o.note) ?? null };
          });
          if (!items.length) return { result: JSON.stringify({ ok: false, error: "items vacío" }), wrote: false };
          const created = await createCredentials(companyId, p.id, items);
          return { result: JSON.stringify({ ok: true, agregadas: Array.isArray(created) ? created.length : items.length }), wrote: true };
        }
        const id = asStr(args.credentialId) ?? "";
        if (!id) return { result: JSON.stringify({ ok: false, error: "falta credentialId" }), wrote: false };
        if (accion === "eliminar") { await deleteCredential(companyId, id); return { result: JSON.stringify({ ok: true }), wrote: true }; }
        if (accion === "editar") {
          const d = (args.data ?? {}) as LooseData;
          const u = await updateCredential(companyId, id, {
            ...(d.optionLabel !== undefined ? { optionLabel: asStr(d.optionLabel) ?? null } : {}),
            ...(d.email !== undefined ? { email: asStr(d.email) ?? null } : {}),
            ...(d.username !== undefined ? { username: asStr(d.username) ?? null } : {}),
            ...(d.password !== undefined ? { password: asStr(d.password) ?? null } : {}),
            ...(d.profileName !== undefined ? { profileName: asStr(d.profileName) ?? null } : {}),
            ...(d.pin !== undefined ? { pin: asStr(d.pin) ?? null } : {}),
            ...(d.note !== undefined ? { note: asStr(d.note) ?? null } : {}),
            ...(d.status !== undefined ? { status: String(d.status).toUpperCase() } : {}),
          });
          return { result: JSON.stringify({ ok: true, estado: (u as { status?: string }).status ?? null }), wrote: true };
        }
        return { result: JSON.stringify({ ok: false, error: "accion inválida: agregar | editar | eliminar" }), wrote: false };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo procesar" }), wrote: false };
      }
    }

    case "configurar_reportes": {
      try {
        const current = await getReportConfig(companyId);
        const d = (args.data ?? null) as LooseData | null;
        let cfg = current;
        if (d && Object.keys(d).length) {
          cfg = { ...(await updateReportConfig(companyId, {
            email: d.email !== undefined ? (asStr(d.email) ?? null) : current.email,
            waPhone: d.waPhone !== undefined ? (asStr(d.waPhone) ?? null) : current.waPhone,
            dailyEnabled: typeof d.dailyEnabled === "boolean" ? d.dailyEnabled : current.dailyEnabled,
            weeklyEnabled: typeof d.weeklyEnabled === "boolean" ? d.weeklyEnabled : current.weeklyEnabled,
            monthlyEnabled: typeof d.monthlyEnabled === "boolean" ? d.monthlyEnabled : current.monthlyEnabled,
            sendHour: d.sendHour !== undefined ? Number(d.sendHour) : current.sendHour,
          })), mailerEnabled: current.mailerEnabled };
        }
        const prueba = asStr(args.prueba);
        const test = prueba === "daily" || prueba === "weekly" || prueba === "monthly" ? await sendReport(companyId, prueba) : null;
        return { result: JSON.stringify({ ok: true, config: cfg, ...(test ? { prueba: test } : {}) }), wrote: Boolean(d && Object.keys(d).length) || Boolean(test) };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo procesar" }), wrote: false };
      }
    }

    case "listar_flujos": {
      const flujos = (await listFlows(companyId)).map((f) => ({
        id: f.id,
        nombre: f.name,
        descripcion: f.description,
        activo: f.isActive,
        disparador: describeTrigger(f.trigger),
        bloques: f.nodeCount,
        link: `/flujos/${f.id}`,
      }));
      return { result: JSON.stringify({ flujos, nota: "ver_flujo muestra los bloques de uno; crear_flujo / editar_flujo los crean o cambian (nacen inactivos); activar_flujo los enciende." }), wrote: false };
    }

    case "ver_bloques_flujo": {
      const [contexto, company] = await Promise.all([
        buildBusinessContext(companyId),
        prisma.company.findUnique({ where: { id: companyId }, select: { botMode: true } }),
      ]);
      return {
        result: [
          NODE_DOCS,
          "",
          HARD_RULES,
          "",
          AUTHORING_HINTS,
          "",
          AUTHORING_EXAMPLE,
          "",
          `DATOS REALES DEL NEGOCIO:\n${contexto}`,
          "",
          `MODO DEL BOT: ${company?.botMode ?? "AI"}. ${
            company?.botMode === "FLOW"
              ? "Los flujos responden; si ninguno se dispara el bot calla. Para que el agente IA continúe tras el flujo, pasa a HYBRID (configurar_empresa botMode)."
              : company?.botMode === "HYBRID"
                ? "El flujo va primero; si ninguno se dispara responde el agente IA. Termina los flujos de calificación con el bloque to-agent (y una note para el agente) en vez de handoff, salvo que el dueño quiera atender él."
                : "Los flujos NO corren: pasa a FLOW (solo flujos) o HYBRID (flujo + agente IA) con configurar_empresa botMode."
          }`,
        ].join("\n"),
        wrote: false,
      };
    }

    case "ver_flujo": {
      try {
        const flow = await findFlowRef(companyId, asStr(args.flowId));
        const resumen = await describeFlow(companyId, flow);
        return {
          result: JSON.stringify({ ok: true, resumen, flujo: { id: flow.id, nombre: flow.name, descripcion: flow.description, activo: flow.isActive, trigger: flow.trigger, nodes: flow.nodes, edges: flow.edges }, link: `/flujos/${flow.id}` }),
          wrote: false,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo leer" }), wrote: false };
      }
    }

    case "crear_flujo": {
      try {
        await assertFlowsAllowedByPlan(companyId);
        const nombre = (asStr(args.nombre) ?? "").trim();
        if (!nombre) return { result: JSON.stringify({ ok: false, error: "Falta el nombre del flujo" }), wrote: false };
        const draft = await normalizeFlowDraft(companyId, { trigger: args.trigger, nodes: args.nodes, edges: args.edges });
        if (!draft.ok) return { result: JSON.stringify({ ok: false, errores: draft.errors, nota: "Corrige los errores y vuelve a llamar crear_flujo con el flujo completo." }), wrote: false };
        const company = await prisma.company.findUnique({ where: { id: companyId }, select: { botMode: true } });
        const avisoModo = company?.botMode === "FLOW" || company?.botMode === "HYBRID" ? undefined : "El bot está en modo AI: los flujos no corren hasta cambiar botMode a FLOW o HYBRID con configurar_empresa.";
        if (args.soloValidar === true) {
          const preview = await describeFlow(companyId, { id: "(sin guardar)", name: nombre, isActive: false, trigger: draft.trigger, nodes: draft.nodes, edges: draft.edges });
          return { result: JSON.stringify({ ok: true, validado: true, guardado: false, resumen: preview, warnings: draft.warnings, avisoModo }), wrote: false };
        }
        const created = await createFlow(companyId, { name: nombre, description: asStr(args.descripcion)?.trim() || undefined });
        const saved = await updateFlow(companyId, created.id, { trigger: draft.trigger, nodes: draft.nodes, edges: draft.edges });
        let activo = saved.flow.isActive;
        const warnings = [...draft.warnings];
        let activacion: string | undefined;
        if (args.activar === true) {
          try {
            const t = await toggleFlow(companyId, created.id, true);
            activo = t.flow.isActive;
            warnings.push(...t.warnings.map((w) => w.message));
          } catch (err) {
            activacion = `No se activó: ${err instanceof Error ? err.message : "error"}${flowErrorDetails(err)}`;
          }
        }
        const resumen = await describeFlow(companyId, { ...saved.flow, trigger: saved.flow.trigger, nodes: saved.flow.nodes, edges: saved.flow.edges });
        return {
          result: JSON.stringify({
            ok: true,
            flowId: created.id,
            nombre: saved.flow.name,
            activo,
            resumen,
            warnings,
            link: `/flujos/${created.id}`,
            avisoModo,
            activacion,
            nota: activo ? "Flujo creado y ACTIVO." : "Flujo creado INACTIVO: pídele al dueño que lo revise en el link y actívalo con activar_flujo cuando confirme.",
          }),
          wrote: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "no se pudo crear";
        const dup = err instanceof AppError && err.statusCode === 409;
        return { result: JSON.stringify({ ok: false, error: msg, nota: dup ? "Usa otro nombre o modifica el existente con editar_flujo." : undefined }), wrote: false };
      }
    }

    case "editar_flujo": {
      try {
        await assertFlowsAllowedByPlan(companyId);
        const flow = await findFlowRef(companyId, asStr(args.flowId));
        const hasGraph = args.nodes !== undefined || args.edges !== undefined;
        const patch: { name?: string; description?: string; trigger?: FlowTrigger; nodes?: FlowNode[]; edges?: FlowEdge[] } = {};
        if (typeof args.nombre === "string" && args.nombre.trim()) patch.name = args.nombre.trim();
        if (typeof args.descripcion === "string") patch.description = args.descripcion.trim();
        let warnings: string[] = [];
        if (hasGraph) {
          const draft = await normalizeFlowDraft(companyId, {
            trigger: args.trigger ?? flow.trigger,
            nodes: args.nodes ?? flow.nodes,
            edges: args.edges ?? flow.edges,
          });
          if (!draft.ok) return { result: JSON.stringify({ ok: false, errores: draft.errors, nota: "Corrige los errores y vuelve a llamar editar_flujo con el flujo completo." }), wrote: false };
          patch.trigger = draft.trigger;
          patch.nodes = draft.nodes;
          patch.edges = draft.edges;
          warnings = draft.warnings;
        } else if (args.trigger !== undefined) {
          const draft = await normalizeFlowDraft(companyId, { trigger: args.trigger, nodes: flow.nodes, edges: flow.edges });
          if (!draft.ok) return { result: JSON.stringify({ ok: false, errores: draft.errors }), wrote: false };
          patch.trigger = draft.trigger;
        }
        if (args.soloValidar === true) {
          const preview = await describeFlow(companyId, { id: flow.id, name: patch.name ?? flow.name, isActive: flow.isActive, trigger: patch.trigger ?? flow.trigger, nodes: patch.nodes ?? flow.nodes, edges: patch.edges ?? flow.edges });
          return { result: JSON.stringify({ ok: true, validado: true, guardado: false, resumen: preview, warnings }), wrote: false };
        }
        if (!Object.keys(patch).length) return { result: JSON.stringify({ ok: false, error: "No enviaste nada que cambiar (nombre, descripcion, trigger, nodes/edges)" }), wrote: false };
        const saved = await updateFlow(companyId, flow.id, patch);
        const resumen = await describeFlow(companyId, saved.flow);
        return {
          result: JSON.stringify({
            ok: true,
            flowId: flow.id,
            nombre: saved.flow.name,
            activo: saved.flow.isActive,
            desactivado: saved.deactivated || undefined,
            erroresQueLoDesactivaron: saved.deactivated ? saved.errors.map((e) => e.message) : undefined,
            resumen,
            warnings,
            link: `/flujos/${flow.id}`,
          }),
          wrote: true,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo editar" }), wrote: false };
      }
    }

    case "activar_flujo": {
      try {
        const flow = await findFlowRef(companyId, asStr(args.flowId));
        const f = await toggleFlow(companyId, flow.id, args.activo === true);
        return {
          result: JSON.stringify({ ok: true, flujo: { id: f.flow.id, nombre: f.flow.name, activo: f.flow.isActive }, warnings: f.warnings.map((w) => w.message), link: `/flujos/${f.flow.id}` }),
          wrote: true,
        };
      } catch (err) {
        const details = err instanceof AppError && err.code === "FLOW_INVALID" ? (err.details as { errors?: { message: string }[] } | undefined)?.errors?.map((e) => e.message) : undefined;
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo cambiar", errores: details, nota: details ? "Corrige con editar_flujo y vuelve a activar." : undefined }), wrote: false };
      }
    }

    case "configurar_pixel_tienda": {
      const cfg = await getMetaCapiConfig(companyId);
      if (typeof args.activo !== "boolean") return { result: JSON.stringify({ capiActivo: cfg.enabled, datasetId: cfg.datasetId ?? null, pixelTienda: cfg.pixelEnabled }), wrote: false };
      if (!cfg.enabled || !cfg.datasetId) return { result: JSON.stringify({ ok: false, error: "Meta CAPI no está configurado: el token y el Dataset ID se cargan en Integraciones (solo desde el panel)." }), wrote: false };
      try {
        await updateMetaCapiConfig(companyId, { enabled: cfg.enabled, datasetId: cfg.datasetId, pageId: cfg.pageId ?? null, testEventCode: cfg.testEventCode ?? null, pixelEnabled: args.activo });
        return { result: JSON.stringify({ ok: true, pixelTienda: args.activo }), wrote: true };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo cambiar" }), wrote: false };
      }
    }

    case "listar_suscripciones": {
      const filtro = asStr(args.filtro) as "active" | "due" | "expired" | undefined;
      const subs = await listSubscriptions(companyId, { filter: filtro ?? "active" });
      const rows = subs.slice(0, 100).map((s) => ({
        id: s.id,
        cliente: { nombre: s.customer?.name ?? null, phone: s.customer?.phone ?? null },
        producto: s.productName,
        plan: s.planLabel,
        vence: s.expiresAt,
        estado: s.status,
        monto: s.amount,
      }));
      return { result: JSON.stringify({ total: subs.length, mostrados: rows.length, items: rows }), wrote: false };
    }

    case "listar_recursos": {
      const tipoRaw = String(args.tipo ?? "").toUpperCase();
      const tipo = (["IMAGE", "VIDEO", "AUDIO", "PDF", "OTHER"].includes(tipoRaw) ? tipoRaw : null) as LibraryResourceType | null;
      const productId = typeof args.productId === "string" && args.productId.trim() ? args.productId.trim() : null;
      const recursos = await listResourceLibrary(companyId, { productId, tipo });
      const porOrigen: Record<string, number> = {};
      for (const r of recursos) porOrigen[r.origen] = (porOrigen[r.origen] ?? 0) + 1;
      return {
        result: JSON.stringify({
          total: recursos.length,
          porOrigen,
          recursos,
          nota: recursos.length
            ? "Para reutilizar uno, pasa su url como mediaUrl (campañas, respuestas rápidas, recordatorios, presentationFollowups, configurar_tienda media). Los privado=true no sirven fuera del chat."
            : "No hay multimedia en productos, recordatorios ni presentaciones. Se sube desde el panel (Productos → Archivos, Recordatorios) o con adjuntar_foto_producto / generar_imagen.",
        }),
        wrote: false,
      };
    }
    case "listar_recordatorios_programados": {
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
      const estado = String(args.estado ?? "PENDING").toUpperCase();
      if (estado !== "PENDING") {
        const status =
          estado === "SENT" ? ScheduledMessageStatus.SENT : estado === "FAILED" ? ScheduledMessageStatus.FAILED : ScheduledMessageStatus.CANCELLED;
        const from = args.desde ? new Date(String(args.desde)) : new Date(Date.now() - 24 * 60 * 60_000);
        const to = args.hasta ? new Date(String(args.hasta)) : undefined;
        const history = await listReminderHistory(companyId, { status, from, to, limit: 500 });
        const company = await prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
        const tz = company?.timezone || "America/Lima";
        const hourOf = (d: Date) => new Intl.DateTimeFormat("es-PE", { timeZone: tz, hour: "2-digit", hour12: false }).format(d);
        const timeOf = (r: { sentAt: Date | null; sendAt: Date }) => r.sentAt ?? r.sendAt;
        // Resumen anti-ráfaga: envíos por hora, separación entre consecutivos y por tipo.
        const porHora: Record<string, number> = {};
        const porTipo: Record<string, number> = {};
        for (const r of history) {
          porHora[`${hourOf(timeOf(r))}:00`] = (porHora[`${hourOf(timeOf(r))}:00`] ?? 0) + 1;
          porTipo[r.type] = (porTipo[r.type] ?? 0) + 1;
        }
        const times = history.map((r) => timeOf(r).getTime()).sort((a, b) => a - b);
        const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000);
        const resumen = {
          total: history.length,
          porHora,
          porTipo,
          separacionSeg: gaps.length
            ? { minima: Math.round(Math.min(...gaps)), promedio: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), maxima: Math.round(Math.max(...gaps)) }
            : null,
          nota:
            status === ScheduledMessageStatus.SENT
              ? "Separación mínima < 20 s o decenas en la misma hora = ráfaga (riesgo de bloqueo). Ajusta con configurar_recordatorios {quietHours.spreadMinutes, pacing}."
              : "failureReason explica cada caso (cliente pagó/cerró, atención humana, fuera de ventana Meta, etc.).",
        };
        const rows = history.slice(0, limit).map((r) => ({
          tipo: r.type,
          estado: r.status,
          fecha: timeOf(r),
          cliente: { nombre: r.customer?.name ?? null, phone: r.customer?.phone ?? null },
          ...(r.failureReason ? { motivo: r.failureReason } : {}),
          texto: String(r.body ?? "").slice(0, 120),
        }));
        return { result: JSON.stringify({ resumen, mostrados: rows.length, items: rows }), wrote: false };
      }
      const tipo = String(args.tipo ?? "").toUpperCase();
      const customerId = args.phone ? (await findCustomerRef(companyId, args.phone)).id : undefined;
      const page = await listPendingReminders(companyId, {
        type: (LISTABLE_TYPES as string[]).includes(tipo) ? (tipo as ScheduledMessageType) : undefined,
        productId: args.productId ? String(args.productId) : undefined,
        customerId,
        lateOnly: args.soloAtrasados === true,
      });
      const lateH = Number(args.atrasadosMasDeHoras);
      const nowMs = Date.now();
      const filtered = Number.isFinite(lateH) && lateH > 0 ? page.items.filter((r) => nowMs - r.dueAt.getTime() > lateH * 3600_000) : page.items;
      const rows = filtered.slice(0, limit).map((r) => ({
        id: r.id,
        tipo: r.type,
        enviaEl: r.sendAt,
        ...(r.stepIndex != null ? { paso: r.stepCount ? `${r.stepIndex + 1}/${r.stepCount}` : r.stepIndex + 1 } : {}),
        atrasoMin: Math.max(0, Math.round((nowMs - r.dueAt.getTime()) / 60_000)),
        cliente: { nombre: r.customer?.name ?? null, phone: r.customer?.phone ?? null },
        texto: String(r.body ?? "").slice(0, 150),
        multimedia: r.mediaUrl ? { tipo: r.mediaType ?? "image", url: r.mediaUrl } : null,
      }));
      return {
        result: JSON.stringify({
          total: page.total,
          atrasados: page.atrasados,
          porTipo: page.porTipo,
          ...(filtered !== page.items ? { coincidenAtraso: filtered.length } : {}),
          mostrados: rows.length,
          nota:
            page.atrasados > 0
              ? "atrasados = pendientes con más de 1 h de retraso. Si crece día a día, la capacidad (tope por hora × horas de envío) no cubre la demanda: reduce pasos de las secuencias o sube el ritmo con configurar_recordatorios {pacing}. El worker envía solo el paso más reciente cuando varios de un cliente están vencidos y vence los muy atrasados."
              : "Sin atrasos: la cola se está cubriendo a tiempo.",
          items: rows,
        }),
        wrote: false,
      };
    }

    case "editar_recordatorio": {
      const id = String(args.id ?? "").trim();
      if (!id) return { result: JSON.stringify({ ok: false, error: "id requerido (de listar_recordatorios_programados)" }), wrote: false };
      const patch: { body?: string; mediaUrl?: string | null; mediaType?: string | null; sendAt?: Date } = {};
      if (typeof args.mensaje === "string") patch.body = args.mensaje;
      if (args.quitarMultimedia === true) patch.mediaUrl = null;
      else if (typeof args.mediaUrl === "string" && args.mediaUrl.trim()) patch.mediaUrl = args.mediaUrl.trim();
      if (typeof args.mediaType === "string" && args.mediaType.trim()) patch.mediaType = args.mediaType.trim();
      if (typeof args.enviarEn === "string" && args.enviarEn.trim()) patch.sendAt = new Date(args.enviarEn);
      if (!Object.keys(patch).length) return { result: JSON.stringify({ ok: false, error: "Indica qué cambiar: mensaje, mediaUrl/quitarMultimedia o enviarEn" }), wrote: false };
      try {
        const r = await updateScheduledReminder(companyId, id, patch);
        return {
          result: JSON.stringify({
            ok: true,
            recordatorio: {
              id: r.id,
              tipo: r.type,
              enviaEl: r.sendAt,
              ...(r.stepIndex != null ? { paso: r.stepCount ? `${r.stepIndex + 1}/${r.stepCount}` : r.stepIndex + 1 } : {}),
              cliente: { nombre: r.customer?.name ?? null, phone: r.customer?.phone ?? null },
              texto: r.body,
              multimedia: r.mediaUrl ? { tipo: r.mediaType ?? "image", url: r.mediaUrl } : null,
            },
            nota:
              r.type === ScheduledMessageType.ABANDONED_CART || r.type === ScheduledMessageType.LEFT_ON_READ
                ? "Si el cliente vuelve a escribir, el bot recrea la secuencia y este cambio se pierde."
                : "Cambio guardado; se envía tal cual a la hora indicada (con el ritmo y horario del negocio).",
          }),
          wrote: true,
        };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo editar" }), wrote: false };
      }
    }

    case "cancelar_recordatorios": {
      const reason = "Cancelado por el dueño (copiloto)";
      const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).map((v) => String(v).trim()).filter(Boolean) : [];
      const f = (args.filtro && typeof args.filtro === "object" ? args.filtro : {}) as Record<string, unknown>;
      const dryRun = args.soloContar === true;
      if (ids.length) {
        if (ids.length > 500) return { result: JSON.stringify({ ok: false, error: "Máximo 500 ids por llamada" }), wrote: false };
        if (dryRun) {
          const seCancelarian = await prisma.scheduledMessage.count({
            where: { id: { in: ids }, companyId, status: ScheduledMessageStatus.PENDING, type: { in: LISTABLE_TYPES } },
          });
          return { result: JSON.stringify({ ok: true, soloContar: true, seCancelarian }), wrote: false };
        }
        const count = await cancelRemindersByIds(companyId, ids, reason);
        const restantes = await listPendingReminders(companyId);
        return {
          result: JSON.stringify({
            ok: true,
            cancelados: count,
            ...(count < ids.length ? { nota: `${ids.length - count} id(s) no existían, no eran de este negocio o ya no estaban pendientes.` } : {}),
            pendientesRestantes: restantes.total,
          }),
          wrote: count > 0,
        };
      }
      const tipo = String(f.tipo ?? "").toUpperCase();
      const late = Number(f.atrasadosMasDeHoras);
      const hasFilter = !!f.phone || !!tipo || !!f.productId || (Number.isFinite(late) && late > 0);
      if (!hasFilter) {
        return { result: JSON.stringify({ ok: false, error: "Indica ids o un filtro (phone, tipo, productId o atrasadosMasDeHoras). No se cancela todo sin filtro." }), wrote: false };
      }
      if (tipo && !(LISTABLE_TYPES as string[]).includes(tipo)) {
        return { result: JSON.stringify({ ok: false, error: `Tipo inválido: ${tipo}` }), wrote: false };
      }
      try {
        const customerId = f.phone ? (await findCustomerRef(companyId, f.phone)).id : undefined;
        const res = await cancelRemindersByFilter(
          companyId,
          {
            type: tipo ? (tipo as ScheduledMessageType) : undefined,
            productId: f.productId ? String(f.productId) : undefined,
            customerId,
            lateMoreThanHours: Number.isFinite(late) && late > 0 ? late : undefined,
          },
          { reason, dryRun },
        );
        const muestra = res.muestra.map((r) => ({ id: r.id, tipo: r.type, horaPlanificada: r.dueAt, cliente: { nombre: r.customer?.name ?? null, phone: r.customer?.phone ?? null } }));
        if (dryRun) {
          return {
            result: JSON.stringify({ ok: true, soloContar: true, seCancelarian: res.count, muestra, nota: "Muestra este número al dueño y cancela solo si confirma (misma llamada sin soloContar)." }),
            wrote: false,
          };
        }
        const restantes = await listPendingReminders(companyId);
        return { result: JSON.stringify({ ok: true, cancelados: res.count, muestra, pendientesRestantes: restantes.total }), wrote: res.count > 0 };
      } catch (err) {
        return { result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : "no se pudo cancelar" }), wrote: false };
      }
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
  "MAPA DEL PANEL (menú lateral). El menú está agrupado por frecuencia de uso: OPERACIÓN (siempre visible: Dashboard, Conversaciones, Comprobantes y la página del rubro), VENTAS (CRM, Campañas, Embudo, Productos), AGENTE IA (Agente IA, Flujos, Recordatorios, Pruebas) y CONFIGURACIÓN (Empresa, Pagos, WhatsApp API, Chat Web, Integraciones, Mi plan) — estos dos últimos grupos aparecen COLAPSADOS por defecto: si el usuario 'no encuentra' una página, dile que despliegue el grupo tocando su título. Centro de ayuda está fijo al PIE del menú, y Activación desaparece del menú al completar el setup:",
  "- Activación (/activacion): checklist de puesta en marcha con % de avance y botón de capacitación 1:1 por WhatsApp. Desaparece del menú al llegar al 100%.",
  "- Dashboard (/dashboard): métricas del negocio.",
  "- Conversaciones (/conversaciones): chats en vivo; el asesor humano puede intervenir (el bot se pausa), usar respuestas rápidas con /comando y reactivar el bot. Los mensajes muestran checks de entrega/lectura (✓/✓✓), las reacciones emoji del cliente y las respuestas citadas. En atención humana el asesor también puede REACCIONAR con emoji a cualquier mensaje y RESPONDER CITANDO un mensaje (como en WhatsApp), pasando el mouse sobre la burbuja. El chat muestra en vivo cuando el cliente está escribiendo o grabando audio, y el cliente ve 'escribiendo…' en su WhatsApp cuando el asesor o el bot redactan. Las llamadas entrantes se rechazan automáticamente y aparecen como evento 📞 en el chat (el bot responde por texto). CHATS FIJADOS: el dueño puede fijar chats sin límite (botón Fijar en el chat o fijar_conversacion por aquí); la lista muestra los 2 fijados más recientes y el resto con 'Ver más'. NO CONTACTAR: si un cliente pide que no le escriban más (ya no me escribas, no me molestes…), el agente se despide en una línea, pasa el chat a atención humana, cancela TODOS sus recordatorios pendientes y avisa al dueño por WhatsApp; el cliente queda marcado 'No contactar' (noContactar en ver_cliente/listar_conversaciones) y campañas de WhatsApp y correo + recordatorios automáticos lo excluyen aunque se reactive el bot. La marca se quita desde el chat (Quitar marca) o con actualizar_cliente {noContactar:false}; se pone a mano con {noContactar:true}. PESTAÑA RECURSOS del chat (junto a Contacto/Respuestas/Notas): lista la BIBLIOTECA de multimedia del negocio — archivos de productos + multimedia de recordatorios (generales y por producto), banner y mensajes adicionales de presentación y mensajes post-venta — con su origen, filtro por producto y buscador; el asesor la envía al cliente con un clic, con o sin su descripción (al enviarla, el panel resuelve las variantes {a|b} y {nombre}); la misma biblioteca se consulta por aquí con listar_recursos. AVISOS AL DUEÑO: cuando el agente deriva a humano (consulta sin respuesta, negociación, reclamo, pago, flujo, campaña) y cuando un cliente escribe en un chat en atención humana, el dueño recibe un WhatsApp con el link directo al chat (flowapp.pe/conversaciones?id=…). TOMAR EL CONTROL DE UN CHAT DESDE AQUÍ (lo mismo que hace el asesor en el panel): leer_conversacion (trae el id de cada mensaje) → enviar_mensaje_cliente (texto y/o imagen/video/PDF por URL, citando con citarMensajeId; por defecto pasa el chat a atención humana) o enviar_respuesta_rapida (/comando con sus acciones) o reaccionar_mensaje (emoji) → programar_recordatorio_cliente para un seguimiento a una hora → al terminar, atencion_humana {activar:false} REACTIVA el bot (si no, el agente IA no vuelve a responderle). Reactivar el bot (desde el panel, con BOT <número> por WhatsApp o con atencion_humana) limpia la derivación: el agente retoma con lo que respondió el asesor y NO vuelve a derivar por el mismo motivo (solo si el cliente pide una persona o hay un problema nuevo). atencion_humana {activar:true} pausa el bot sin escribir. iniciar_conversacion abre un chat con un número nuevo (solo tras confirmación; en Meta no se puede sin plantilla). reiniciar_conversacion borra el historial (irreversible, solo tras confirmación). Límites automáticos de los envíos del copiloto: nunca a clientes noContactar; en Meta solo dentro de la ventana de 24 h desde el último mensaje del cliente (fuera de ella usa un recordatorio o campaña con plantilla); ritmo anti-bloqueo igual al de los recordatorios (tope por hora y separación entre clientes distintos; si devuelve reintentarEnSeg, espera). La firma del negocio se agrega sola a cada mensaje. Escribe como una persona del negocio: corto, una idea y una pregunta; precios, pagos y enlaces SOLO de ver_producto/ver_configuracion/ver_tienda, nunca inventados.",
  "- CONVERSACIONES (/conversaciones): la lista del panel busca y filtra en TODO el historial del negocio (nombre, teléfono, etapa, etiqueta, anuncio) con scroll infinito, y los mensajes de cada chat se cargan por tramos (los más recientes primero, «Cargar anteriores» arriba). En móvil: lista → chat (atrás vuelve a la lista) → herramientas en hoja inferior (Contacto, Respuestas, Notas, Recursos); el menú ⋯ del chat tiene Fijar, Etiquetas, Recordatorio, No contactar, Fondo, Reiniciar y Eliminar; escribir en un chat con el bot activo toma el control automáticamente.\n" +
  "- COLA DE RECORDATORIOS: cada respuesta del bot programa TODOS los pasos de la secuencia de golpe (delays desde ese momento). El worker respeta el tope por hora y el horario; si varios pasos de un cliente están vencidos envía solo el más reciente (activando el precio de la oferta escalonada más avanzada; nunca sube un precio ya ofrecido) y cancela los demás; un paso con más de 12 h de atraso vence si ya hay uno más nuevo (48 h si es el último); el paso 1 de cada lead tiene prioridad sobre pasos atrasados. listar_recordatorios_programados muestra el total real y los atrasados: si los atrasados crecen, la capacidad (tope/hora × horas) no cubre la demanda. cancelar_recordatorios cancela uno, una selección por ids o un lote por filtro (cliente, tipo, producto, atraso): en lote primero soloContar y confirmación del dueño. editar_recordatorio cambia el texto, la multimedia o la hora de UN recordatorio pendiente (en el panel: Recordatorios → Programados → ✎ Editar); para cambiar muchos, cambia la secuencia.\n" +
  "- CRM (/crm): tablero kanban de clientes con columnas y etiquetas (módulo CRM). El Inbox del panel muestra los últimos 100 contactos sin colocar con «Cargar más» y búsqueda por nombre/teléfono; los clientes siguen existiendo aunque no estén en pantalla. CLIENTES por chat: ver_cliente (ficha + notas), actualizar_cliente (nombre, correo, número, datos), agregar_nota_cliente, gestionar_cliente_crm (columna/etiquetas; con quitarRespuestasFlujo borra las respuestas del chatbot 📝 que se ven en la tarjeta y en Contacto — el agente las volverá a preguntar; solo tras confirmación) y eliminar_cliente (solo tras confirmación). PEDIDOS: actualizar_pedido cambia el estado (avisa al cliente como el panel). CITAS: crear_cita, actualizar_cita (estado o reprogramar) y bloquear_horario (bloqueos de agenda: crear, listar, quitar). CALENDARIO: tras cada cita confirmada por el agente o un flujo, el cliente recibe por WhatsApp enlaces para agregarla a Google Calendar / iPhone (crear_cita devuelve esos enlaces en 'calendario' para que el dueño los pegue si la creó a mano) y, si tiene correo en su ficha, una invitación por email. El dueño ve TODAS sus citas y bloqueos en su propio calendario suscribiendo la URL ICS de Empresa → Agenda → «Calendario en tu teléfono» (iPhone: Ajustes → Calendario → Cuentas → Añadir cuenta → Otro → Añadir calendario suscrito; Google Calendar: Otros calendarios → + → Desde URL; Outlook: Agregar calendario → Suscribirse desde web). Es de UN solo sentido (FlowApp → calendario) y se refresca cada ~1 h según el dispositivo; no hay sincronización con Google OAuth. VIDEOLLAMADA (citas online): el dueño pega un enlace FIJO de Meet/Zoom en el servicio (actualizar_producto verticalData.meetingUrl) o uno por defecto para todo el negocio (configurar_empresa meetingUrl); con eso el cliente recibe '🎥 Enlace de la videollamada' junto con los enlaces de calendario al confirmar/reprogramar, en los recordatorios, en el evento del calendario (como ubicación) y en el correo. No se envía si la cita quedó como presencial (modality) o si no hay enlace. Para crear la sala fija de Meet: meet.google.com → «Nueva reunión» → «Crear una reunión para más tarde» → copiar el enlace (los clientes piden unirse y el dueño los admite; Google borra la sala si pasa 1 año sin usarse). crear_cita devuelve 'calendario.meetingUrl'. Aún no hay enlace único por cita (eso requeriría conectar Google con OAuth). REPROGRAMAR: el agente ve en su prompt la cita vigente del cliente y la MUEVE con reprogramar_cita; agendar_servicio no crea una segunda cita si ya hay una vigente (solo con adicional:true). Si el dueño ve citas duplicadas de antes de este cambio, cancele la vieja con actualizar_cita.",
  "- Campañas (/campanas): envíos masivos por WhatsApp (módulo Campañas). Puedes crearlas tú con crear_campana (queda EN BORRADOR): audiencia por etiquetas del CRM, etapa del embudo, anuncio de origen o teléfonos; secuencia de mensajes con {nombre} y SPINTAX {Hola|Buenas|Qué tal} (cada destinatario recibe una variante — recomiéndalo siempre); y ritmo anti-ban con RANGOS aleatorios definidos por el usuario (intervalSec–intervalMaxSec entre contactos, pausa pauseSec–pauseMaxSec cada pauseEvery), tope diario y horario HH:mm. DEFAULTS SEGUROS si no se indica otra cosa: 45–90 s entre contactos, pausa 180–300 s cada 10, tope 60/día (cuenta todas las campañas del negocio), horario 09:00–21:00. GOTCHAS: sin sendFrom, el tope diario reanuda a MEDIANOCHE (recomienda horario 09:00–21:00); tiempos exactos sin rango son patrón detectable (recomienda rango, ej. 60–120 s); en números nuevos recomienda tope diario 30–50 y subirlo de a poco; sin spintax todos reciben el mismo texto (pide ≥3 variantes en saludo, verbo y cierre; nunca en precios ni links). PROTECCIONES AUTOMÁTICAS: solo UNA campaña en curso por negocio; si 5 envíos seguidos fallan se pausa sola (pauseReason failures) y avisa al dueño por WhatsApp. Flujo seguro OBLIGATORIO: previsualizar_audiencia_campana (total real tras exclusiones) → crear borrador → mostrar total + resumenDeEnvio al usuario → enviar_prueba_campana a su número → iniciar_campana SOLO tras su confirmación explícita (el envío masivo es irreversible) → ver_campana para el seguimiento (cómo va, por qué espera, fallidos) → pausar_campana / reanudar_campana (reversibles) o cancelar_campana (irreversible, confirmación con el nombre). MULTIMEDIA EN CAMPAÑAS: para adjuntar algo ya subido (archivo de producto, video de un recordatorio, banner de presentación) usa listar_recursos y pasa su url como mediaUrl en los mensajes — en el panel es el botón 'Insertar recurso' del paso Mensajes.",
  "- FLUJOS — secuencia OBLIGATORIA: (1) ver_bloques_flujo y ver_crm ANTES de diseñar (nunca inventes ids: usa nombres o los ids reales); (2) propón al dueño el flujo en lenguaje llano — qué pregunta y qué opciones numeradas verá el cliente (muéstrale el texto tal cual le llegará), qué etiqueta/columna pone cada rama, cuándo avisa al dueño, si agenda cita — y espera su confirmación; (3) crear_flujo con soloValidar=true para comprobar, luego sin él; (4) muéstrale el link /flujos/<id> y las warnings; (5) activar_flujo SOLO tras confirmación explícita, avisando que en modo FLOW el bot calla si ningún flujo se dispara (en HYBRID responde el agente) y que el modo se cambia con configurar_empresa botMode; (6) para modificar uno existente, ver_flujo primero y devuelve el grafo COMPLETO conservando ids y posiciones. GOTCHAS: en HYBRID termina el flujo de calificación con to-agent (clientText opcional + note con lo que el agente debe hacer) en vez de handoff, salvo que el dueño quiera atender él; las respuestas del flujo (saveVariable) quedan en la ficha del cliente (Conversaciones → Contacto, tarjeta del CRM, ver_cliente/leer_conversacion) y el agente las recibe como contexto; si el dueño capta leads por Meta Ads, propón trigger onAdLead (no keywords) y acciones CRM en el anuncio (configurar_anuncio); etiquetas según rango (presupuesto, tipo de cliente) requieren un bloque answers (opciones numeradas; el cliente responde con el número o el nombre) con una rama por opción, no question libre; en answers el message es SOLO la pregunta: la lista «1. … 2. …» la agrega el sistema y NUNCA se crean opciones separadas para «1»,«2»… (duplicarían ramas); para menús de 7+ opciones usa list; no existen botones de WhatsApp, todo es texto; las variables guardadas (saveVariable) solo llegan al dueño si el notifyText del handoff las incluye con {{variable}}; book-appointment necesita un servicio con durationMin; un flujo de captación típico: answers (qué necesita, una opción por servicio) → crm-add-tags → crm-move → answers (tipo/presupuesto) → crm-add-tags → question (descripción) → to-agent (HYBRID) o handoff con aviso que incluya {{nombre}} {{telefono}} y las variables (ver_bloques_flujo trae un EJEMPLO completo).",
  "- Campañas: además de mensajes, cada campaña puede llevar PASOS por contacto (esperar N segundos, etiquetar/quitar etiquetas, mover a una columna del CRM, pasar a modo humano) y etiquetas de contexto a cada alcanzado (crear_campana pasos / etiquetasContexto, actualizar_campana en borrador, eliminar_campana tras confirmación). Las respuestas rápidas también ejecutan ACCIONES al enviarse: mover al CRM, etiquetar/quitar etiquetas, marcar entregado y fijar el producto presentado (crear/actualizar_respuesta_rapida acciones por nombres).",
  "- Embudo (/embudo): embudo de ventas (módulo Embudo).",
  "- Comprobantes (/comprobantes): pagos/vouchers recibidos y su validación. Por chat: listar_comprobantes (con id) y, tras confirmación explícita, aprobar_comprobante (cuenta como venta y entrega), rechazar_comprobante, ignorar_comprobante y asociar_comprobante (producto/teléfono). Desde la ficha del cliente (Conversaciones → pestaña Contacto) el asesor también puede reenviar el acceso de una compra aprobada POR CORREO (si el producto tiene entrega por correo activa).",
  "- Pedidos (/pedidos): solo rubros restaurante y comercial. Reservas (/reservas) y Reservas online (/reservas-online): solo rubros servicios e inmobiliaria. Vencimientos (/vencimientos): solo rubro streaming.",
  "- Productos (/productos): el catálogo que vende el agente (esto también lo configuro YO por chat). Los productos digitales pueden tener ENTREGA POR CORREO a pedido del cliente (editar producto → paso 'Entrega del acceso' → pestaña '📧 Correo', o digitalDelivery.emailEnabled por chat): si el cliente que ya pagó pide el acceso por email, el agente se lo envía y guarda su correo. También pueden tener INVITACIÓN A LA TIENDA (pestaña '🛍️ Tienda' o digitalDelivery.storeInviteEnabled): el último mensaje tras entregar invita a visitar la tienda web con su link (reemplaza al cross-sell y al catálogo; requiere tienda publicada). Cada producto puede tener OFERTA con vigencia (precio de oferta + desde/hasta): vigente, el agente la presenta, cobra y valida ese precio y el normal sale tachado como 'antes'. Además hay OFERTAS ESCALONADAS en los recordatorios: cada paso puede llevar su precio (si el cliente no compra, el recordatorio 1 ofrece un precio y el 2 uno mejor — solo para ese cliente).",
  "- Empresa (/empresa): nombre, rubro, zona horaria, MONEDA del negocio (soles S/ por defecto o dólares $ — todo el embudo la usa: fichas, carrito, cobro, validación, reportes), horario de atención, delivery, firma. Incluye el tab Anuncios: catálogo de anuncios Meta (mapea IDs/títulos de anuncios a descripciones amigables para los leads y el reporte por anuncio).",
  "- Mi plan (/mi-plan): plan actual, leads del mes, renovar/cambiar plan pagando con Mercado Pago (1 o 12 meses), recargar créditos y canjear vales.",
  "- Agente IA (/agente): prompt del agente, estilo, comportamiento comercial, PROVEEDOR DE IA (OpenAI, Anthropic Claude o Google Gemini), modelo y API keys (necesarias para el agente y para este copiloto). Cambiar de proveedor pide ingresar la API key de ese proveedor. Modelos Claude disponibles: claude-haiku-5-5 (rápido y económico, recomendado), claude-sonnet-5-5 (alta calidad) y claude-opus-5-5 (máxima calidad, más caro); en los Claude 5.x la temperatura no aplica (el panel la deshabilita). Las notas de voz de WhatsApp se transcriben con OpenAI (Whisper) y las imágenes del copiloto se generan con OpenAI: si el proveedor es Claude/Gemini hay un campo aparte y opcional para una key de OpenAI para audios e imágenes — sin ella los audios no se transcriben ni se generan imágenes; el resto (agente, comprobantes, copiloto) corre con el proveedor elegido. HERRAMIENTA DE CRM DEL AGENTE (Agente IA → Comportamiento → «CRM automático del agente»; por chat configurar_agente crmTool): APAGADA por defecto; cuando se activa, el agente puede mover al cliente SOLO a las columnas permitidas y poner/quitar SOLO las etiquetas permitidas de UN tablero, y SOLO cuando se cumple la regla 'cuando' escrita para cada una (obligatoria); además 'solo avanzar' (no retrocede columnas), tope de acciones por turno (default 1), rastro en Notas del cliente y aviso por WhatsApp al dueño en cada cambio. Buenas prácticas al proponerla: columnas de hitos conversacionales (p. ej. «Propuesta enviada» cuando pide la cotización por escrito, «Reunión agendada» cuando la cita quedó confirmada, «Perdido / En pausa» cuando dice explícitamente que no le interesa) y etiquetas de temperatura (p. ej. «🔥 Caliente» cuando pide precio/fecha/propuesta); NO permitir columnas de entrada (las maneja el flujo/anuncio) ni de pago/ganado (las maneja la validación de comprobantes). Propón las reglas por escrito y actívala SOLO tras confirmación.",
  "- MODOS DEL BOT (Empresa → Modo de operación; configurar_empresa botMode): AI = el agente IA conversa libre con el catálogo (recomendado para vender); FLOW = solo flujos guiados por bloques (predecible; si ningún flujo se dispara el bot calla; handoff pausa para humano); HYBRID = el flujo recibe y califica (botones, etiquetas, columnas, origen por anuncio) y luego el agente IA continúa con esas respuestas como contexto (bloque to-agent) — si ningún flujo se dispara, responde el agente. Recomienda HYBRID para servicios/leads que primero se califican y luego se conversan; AI y HYBRID requieren key de IA (solo desde el panel).",
  "- Flujos de chatbot (/flujos): flujos guiados por bloques (módulo Flujos) que corren cuando el bot está en modo FLOW o HYBRID. Puedes CREARLOS y EDITARLOS por chat: ver_bloques_flujo (bloques, reglas y datos reales) → diseña → crear_flujo / editar_flujo (nacen INACTIVOS, link /flujos/<id>) → activar_flujo. El editor visual del panel sigue disponible para retocarlos. REPORTES programados (correo/WhatsApp, diario/semanal/mensual): configurar_reportes (ver, cambiar, enviar prueba). SUSCRIPCIONES (STREAMER): gestionar_suscripcion (crear/renovar/cancelar) y el INVENTARIO de cuentas con ver_inventario_streaming / actualizar_inventario_streaming (agregar, editar, eliminar credenciales). PÍXEL de la tienda: configurar_pixel_tienda enciende/apaga el píxel si CAPI ya está configurado en Integraciones (tokens solo desde el panel).",
  "- Recordatorios (/recordatorios): mensajes programados (carrito abandonado, dejado en visto, recordatorios de cita, renovaciones). ANTI-BLOQUEO (pestaña Horario): lo que cae fuera de horario NO sale todo a la hora de apertura — se dispersa al azar en los primeros minutos (spreadMinutes, default 90) y los recordatorios de la empresa salen espaciados (pacing 25-70 s al azar, tope 60/hora; si hay una campaña enviando, el ritmo se duplica). Los mensajes admiten SPINTAX {Hola|Buenas|Qué tal} para variar el texto entre clientes. Si el usuario sufrió un bloqueo de WhatsApp: recomienda ritmo 60-120 s, tope 20-30/h y dispersión 120 min la primera semana, textos con spintax y {nombre}, y no programar campañas en la misma franja que los recordatorios.",
  "- Pagos (/pagos): métodos de pago manuales que el bot ofrece (Yape/Plin/cuentas), modo de cobro y WhatsApp de avisos.",
  "- WhatsApp API (/whatsapp): conexión del canal (ver arriba).",
  "- Chat Web (/chat-web): widget de chat con IA para la web del negocio — genera un snippet <script> con token para pegar en su página, con dominios permitidos, color y bienvenida (módulo Chat web).",
  "- Tienda web (/tienda-web): página pública de venta del negocio en <slug>.flowapp.pe (módulo Tienda web) que muestra automáticamente los productos DIGITALES del catálogo que tengan entrega por correo activa; el comprador paga con Mercado Pago (tarjeta) o con Yape/Plin (ve los números de Pagos, sube la captura del comprobante y el sistema la lee con visión y la cruza con los comprobantes pendientes igual que el chat; si no la valida sola queda EN_REVISION, el sistema reintenta ~10 min y avisa al dueño por WhatsApp, y el dueño la aprueba o rechaza en Tienda web → Pedidos o con aprobar_pedido_tienda / rechazar_pedido_tienda) y recibe el acceso por correo (y por WhatsApp si deja su número); cada compra crea un comprobante APROBADO con canal 'tienda web' y avisa al dueño. Requisitos: identificador (slug) válido en Empresa, al menos un cobro (Mercado Pago conectado en Integraciones y habilitado para el canal tienda, o métodos Yape/Plin en Pagos con la opción 'Aceptar Yape/Plin' de la tienda activa) y productos con entrega por correo. Se consulta con ver_tienda y se configura con configurar_tienda (título, frase, color, WhatsApp del botón, productos, manualPaymentsEnabled, portada); configurar_tienda es PARCIAL: fusiona con lo guardado, solo cambia lo que mandas (null borra) y las listas se reemplazan completas, así que nunca mandes productOverrides de productos que no cambian. En el panel, Tienda web tiene pestañas (ver más abajo); el carrusel de portada admite hasta 5 productos destacados con banner y 3 estilos (ambiente, tarjeta o póster) con titular resaltado, bullets y prueba social; los Yape/Plin en revisión se aprueban en Pedidos. La tienda pública tiene barra de anuncio (configurar_tienda announcement), cabecera oscura con buscador y carrito, carrusel (portada), franja de confianza con iconos, COMBOS POR VOLUMEN (volumePricing: tramos '3 o más −20 %' y 'todos los packs' a precio fijo; el descuento se calcula en el checkout y se ve en tarjetas, barra de carrito fija, cajón del carrito con barra de progreso y 'Completa tu pedido'), checkout dentro del cajón, y cada ficha es una LANDING DE VENTAS (productOverrides[id].landing: titular gancho, video, cifras, dolor/solución, 'Lo que recibes hoy' con includes/bonos, muestra, testimonios, checkout inline con garantía (salesSettings.guarantee), ORDER BUMP a precio especial, cupón, FAQ y barra fija inferior). Color del botón de compra, título del catálogo, posición de la barra fija de compra de la landing (salesSettings.landingBar: arriba/abajo/ambas) y PIE configurable (salesSettings.footer: tema automático/oscuro/claro, bloque de suscripción con sus textos y línea del negocio (nombre, frase, pagos, WhatsApp, nota) activables por separado) en salesSettings. Cada recurso de muestra puede llevar un botón de compra debajo (media[].cta). Los botones de compra tienen un efecto configurable (salesSettings.ctaEffect). El panel de Tienda web tiene pestañas Resumen · Apariencia (Identidad, Cobros y contacto, Catálogo) · Productos (visibles, orden, Personalizar) · Portada (Carrusel, Franja, Precios) · Landing (Barra de compra, Efecto, Garantía, Pie) · Combos · Cupones · Correos (Automáticos, Promociones, Historial) · Pedidos. Cada producto puede tener portada, varias categorías (etiquetas), descripción corta, orden y RECURSOS DE MUESTRA (PDF, video, imágenes que el comprador ve en la ficha) propios para la tienda (Apariencia y cobro → Productos visibles → Personalizar) sin tocar el producto que usa el agente de WhatsApp (configurar_tienda productOverrides). ARCHIVOS PROTEGIDOS: en el paso Archivos del producto, 'Solo por enlace firmado (privado)' saca el archivo de la URL pública; se entrega como enlace firmado de 7 días en el correo, en la página de gracias y en el chat (actualizar_producto files[].privateDownload=true). Las FAQ de la ficha salen del producto (se pueden ocultar algunas solo en la tienda con landing.faqHiddenIds) más preguntas propias de la tienda (landing.faqExtra); los recordatorios por correo admiten cupón por producto (couponByProduct). La portada de cada producto en la tienda se puede cambiar u ocultar (productOverrides imageUrl/hiddenImages) sin tocar el producto; los recursos de muestra se previsualizan en el panel. CORREOS AUTOMÁTICOS (Tienda web → Correos): checkout abandonado (hasta 3 correos cuando un pedido queda sin pagar; se cancelan al pagar), post-compra a los N días con el producto relacionado y cupón, y bienvenida a quien se suscribe en el pie de la tienda; cada correo lleva enlace de baja y nunca se envía a quien se dio de baja; se configuran con configurar_tienda emailReminders y se consultan en ver_tienda → correos. PROMOCIONES POR CORREO (Tienda web → Correos → Promociones): campañas a compradores, suscriptores, contactos de WhatsApp con correo, por etiqueta, contactos elegidos a mano, correos pegados o CSV con campos propios (campo1..3, cupón por persona); solo a quien tiene consentimiento y no se dio de baja; ritmo y tope diario automáticos; métricas de clics y compras atribuidas (listar_campanas_correo, previsualizar_audiencia_correo, crear_campana_correo, enviar_prueba_campana_correo). CUPONES: ver_cupones / crear_cupon / editar_cupon / desactivar_cupon (también en Tienda web → Cupones); el comprador los escribe en el checkout. CUENTA REGRESIVA: si un producto tiene oferta con offerEndsAt, la tienda muestra 'Termina en hh:mm:ss' automáticamente. La página de gracias ofrece el producto RELACIONADO (cross-sell del producto comprado, si está visible en la tienda) como upsell, y el panel (Resumen) muestra métricas con los mismos filtros del dashboard (hoy, ayer, 7/30 días, mes, 12 meses, rango) y por producto, con el EMBUDO visitas → vistas → carrito → pago → compras y el % de cada paso (ver_tienda → metricas, con dias o desde/hasta y productId). Los pedidos de prueba se pueden ELIMINAR con lo relacionado (Pedidos → Eliminar o eliminar_pedido_tienda, tras confirmación). Extras: botón 'Comprar por WhatsApp' en cada producto (usa el WhatsApp del botón), carrito multi-producto, previews con imagen al compartir el link, y píxel de Meta: en Integraciones → Meta Conversions API, el check 'Insertar el píxel en la tienda web' usa el Dataset ID como píxel (PageView/ViewContent/AddToCart/InitiateCheckout/Purchase, con advanced matching del correo/teléfono al iniciar el checkout) y reporta cada compra web por CAPI sin duplicar; en el dashboard las ventas de la tienda aparecen como fuente 'Tienda web' (solo desde el panel; el copiloto no gestiona tokens). Si en Integraciones la comisión de Mercado Pago la asume el CLIENTE, la tienda muestra el total con recargo en el botón y una nota antes de ir a Mercado Pago (Yape/Plin nunca lleva recargo).",
  "- Pruebas (/pruebas): simulador para chatear con el agente sin gastar WhatsApp real.",
  "- Integraciones (/integraciones): Mercado Pago (links de pago automáticos: se pega el Access Token APP_USR-… de mercadopago.com.pe/developers; módulo Mercado Pago; en Configurar se elige POR CANAL si se usa en el cobro por chat y/o en la tienda web — p. ej. solo tienda), ValidPay para Yape/Plin automático (secret + webhook; módulo Webhooks) el CONECTOR MCP: una URL para configurar FlowApp Y analizar los datos del negocio conversando desde Claude (claude.ai/Claude Desktop) o Cursor — se activa, se copia la URL y se regenera el token ahí mismo; y META CONVERSIONS API: reporta cada venta cerrada al anuncio Meta de origen (ctwa_clid) para que Meta optimice las campañas hacia COMPRADORES (el token es un SECRETO: se configura solo en el panel, con Dataset ID del Administrador de eventos).",
  "- Centro de ayuda (/ayuda): manuales, videos y guías publicados por FlowApp.",
  "",
  "PLANES Y MÓDULOS: cada plan incluye módulos (Campañas masivas, CRM kanban, Flujos guiados, Embudo de ventas, Chat web, Mercado Pago, Webhooks, Tienda web) y un límite de leads/mes. Si una página no aparece en el menú del tenant es porque su plan no incluye ese módulo o su rubro no la usa. Los precios vigentes están en la sección PLANES de este prompt; el plan propio del negocio se consulta con ver_mi_plan.",
  "=== FIN DE LA GUÍA ===",
].join("\n");

// ---------------------------------------------------------------------------
// System prompt + snapshot del negocio
// ---------------------------------------------------------------------------
export async function buildSystem(companyId: string): Promise<string> {
  const [company, productCount, agent, payment, plansSection] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, vertical: true, timezone: true } }),
    prisma.product.count({ where: { companyId } }),
    prisma.agentConfig.findUnique({ where: { companyId }, select: { basePrompt: true } }),
    prisma.paymentConfig.findUnique({ where: { companyId }, select: { enabled: true, methods: { select: { id: true }, take: 1 } } }),
    getLivePlansPromptSection().catch(() => ""),
  ]);
  const vertical = company?.vertical ?? "OTHER";
  return [
    `Eres el COPILOTO de FlowApp para el negocio "${company?.name ?? "—"}". Ayudas al dueño (usuario NO técnico) en español, rápido y sin formularios: CONFIGURAS su negocio conversando y ANALIZAS sus datos reales (ventas, conversiones, conversaciones).`,
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
    "- Además de productos, puedes configurar la EMPRESA (nombre, zona horaria, delivery, horario de atención, firma), el AGENTE IA (prompt, estilo, reglas, comportamiento comercial; flags: negotiationHandoff = negociar una vez y derivar, unknownHandoff = derivar con motivo CONSULTA cuando no sabe responder en vez de inventar o prometer 'consultar', humanChatAlerts = avisar al dueño por WhatsApp cuando un cliente escribe en un chat en atención humana), los PAGOS manuales (Yape/Plin/cuentas, modo de cobro, WhatsApp de avisos), el CRM COMPLETO (crear, renombrar, cambiar colores, reordenar y eliminar tableros/columnas/etiquetas; mover o etiquetar clientes por teléfono), el CHAT WEB (bienvenida/color/dominios), los RECORDATORIOS automáticos (carrito abandonado, dejado en visto, horario permitido), los FLUJOS de chatbot (ver_bloques_flujo, ver_flujo, crear_flujo, editar_flujo, activar_flujo) y las RESPUESTAS RÁPIDAS del asesor (atajos /comando con secuencias de texto/multimedia que un humano envía desde Conversaciones — el bot no las usa solo; los adjuntos de esta conversación sirven como multimedia de la secuencia; si la respuesta tiene «Marcar la venta como entregada», al usarla en el panel el asesor elige el canal: solo por el chat, solo por correo o ambos — el correo solo sale para productos con entrega por correo activa y deja una nota 📧 en el chat). Usa ver_configuracion / ver_crm / ver_respuestas_rapidas antes de proponer cambios en esas áreas.",
    "- ATRIBUCIÓN DE ANUNCIOS META: los leads que llegan desde un anuncio (CTWA) quedan marcados con el anuncio de origen; ver_metricas trae rendimientoPorAnuncio (leads, ventas, ingresos y conversión POR ANUNCIO — así se sabe qué anuncio cierra ventas de verdad). El catálogo de anuncios (ver_catalogo_anuncios/configurar_anuncio, o en Empresa → Anuncios) mapea IDs/títulos crudos a descripciones amigables; varios identificadores pueden apuntar a la misma descripción, y cada anuncio puede VINCULARSE A UN PRODUCTO: el lead que llega por ese anuncio entra con ese producto como PRODUCTO EN FOCO y el agente lo PRESENTA DE INMEDIATO en su primer mensaje (presentación forzada de forma determinista: aunque el lead solo diga 'Hola', recibe la ficha completa sin que se le pregunte qué busca). Además cada anuncio puede ETIQUETAR y MOVER al lead en el CRM al llegar (configurar_anuncio etiquetas/tablero/columna; p. ej. 'Origen: Meta Ads' → columna 'Nuevo lead'; funciona en modo AI y FLOW) y los flujos pueden dispararse SOLO para leads de anuncio con el trigger onAdLead (primer mensaje atribuido, prioridad sobre keywords; opcionalmente restringido a ciertos anuncios): es la forma recomendada de calificar leads de Meta aunque escriban 'Hola'.",
    "- ANALISTA DEL NEGOCIO: puedes leer métricas, ventas, comprobantes, pedidos, conversaciones (incluidos los MENSAJES reales con leer_conversacion), citas, campañas, suscripciones y recordatorios con ver_metricas/listar_*. Para preguntas de números usa PRIMERO ver_metricas (trae el periodo comparado con el anterior) y detalla después con listar_*. TODO número que cites debe salir de un resultado de tool de ESTE turno — NUNCA estimes ni 'recuerdes' cifras. Con los datos puedes proponer mejoras accionables (FAQs/objeciones a partir de chats reales, ofertas escalonadas para carritos abandonados, ajustes de prompt o recordatorios) y, SOLO si el usuario confirma, aplicarlas con las tools de escritura. Con previsualizar_ficha ves EXACTAMENTE cómo el agente presenta un producto al cliente (secuencia real de mensajes, multimedia y modo de presentación, en cualquier rubro) — úsala antes de proponer mejoras de copy o de estructura de la ficha. BLOQUEOS DE WHATSAPP: si el usuario reporta un bloqueo o te pide revisar el riesgo, (1) lee ver_configuracion.recordatorios (dispersión, ritmo, tope efectivos), (2) analiza los envíos reales con listar_recordatorios_programados estado=SENT (resumen: envíos por hora y separación mínima entre consecutivos — < 20 s o decenas en la misma hora = ráfaga) y las campañas recientes con listar_campanas, y (3) propón valores concretos (tras un bloqueo: dispersión 120, pausa 60-120 s, tope 20-30/h; sin bloqueo: 90 · 25-70 · 60) y mensajes con spintax; aplícalos con configurar_recordatorios SOLO tras confirmación. RESPUESTAS QUE SUENAN A BOT: si el usuario reporta mensajes repetitivos o que ignoran lo que pidió el cliente, lee el chat con leer_conversacion, identifica el patrón (texto redundante tras una herramienta, duda sin responder, cierre repetido) y propón reglas concretas para el agente (configurar_agente rules) — el sistema ya descarta el texto redundante tras enviar los métodos de pago y espera 8 s para juntar mensajes seguidos del cliente.",
    "- DIAGNÓSTICO: si el dueño reporta que el bot responde a todos 'Disculpa, estoy teniendo un inconveniente', casi siempre es el PROVEEDOR DE IA fallando: sin créditos/saldo (recargar en la cuenta del proveedor, ej. OpenAI → Billing) o API key inválida — se revisa/corrige en el panel (Agente IA). El sistema avisa al dueño por WhatsApp al primer fallo accionable y de nuevo al recuperarse; el agente revive solo al corregir la causa, sin reiniciar nada.",
    "- DISEÑADOR: con generar_imagen creas banners de oferta, fotos de producto y creativos con IA (se guardan en el servidor y su URL sirve en cualquier configuración: banner de presentación, pasos de recordatorio, followups, respuestas rápidas, campañas, o como foto de producto vía adjuntar_foto_producto). Cuesta dinero al negocio (usa su key de OpenAI) → SOLO tras confirmación. Flujo OBLIGATORIO: generar → mostrar la URL al usuario → su aprobación → adjuntar → verificar (previsualizar_ficha). Textos del banner van LITERALES entre comillas en el prompt. Si el negocio no tiene key de OpenAI, deriva al panel (Agente IA); JAMÁS pidas ni recibas keys por chat.",
    "- HONESTIDAD DE ACCIONES: solo puedes hacer lo que tus herramientas permiten. Si no tienes herramienta para algo, DILO claramente y sugiere dónde hacerlo en el panel. NUNCA digas que actualizaste, cambiaste o eliminaste algo sin haber llamado la herramienta correspondiente y recibido ok.",
    "- RECORDATORIOS: los generales del negocio van por configurar_recordatorios; los PROPIOS de un producto (y la renovación de streaming) van en el campo reminderConfig del producto (actualizar_producto). Una secuencia post-venta PROGRAMADA (días después de la compra) NO existe como configuración: si te la piden, ofrece los mensajes post-entrega (digitalDelivery.followupMessages, inmediatos tras entregar) y dilo con honestidad.",
    "- ONBOARDING de un negocio nuevo (catálogo vacío): el ORDEN correcto es (1) confirmar rubro y datos de la empresa — el rubro se BLOQUEA en cuanto existan productos —, (2) crear los productos, (3) configurar pagos, (4) ajustar el agente. Guía al usuario en ese orden sin abrumarlo.",
    "- actualizar_producto/configurar_empresa/configurar_agente/configurar_pagos son PARCIALES y ADITIVOS: envía solo los campos a cambiar; el resto se conserva, y las LISTAS enviadas (beneficios, FAQs, aliases, variantes, métodos de pago, reglas, dominios, mensajes) se AGREGAN/FUSIONAN con lo existente — NUNCA borran nada por sí solas. Para QUITAR un elemento o reescribir una lista completa: lee lo actual (ver_producto/ver_configuracion), confirma con el usuario QUÉ se elimina, y llama la tool con el flag reemplazar*/reemplazar=true enviando la versión FINAL completa.",
    "- eliminar_producto, eliminar_pedido_tienda, eliminar_campana, eliminar_cliente, reiniciar_conversacion, iniciar_conversacion y cancelar_recordatorios: SOLO si lo pidió explícitamente y confirmó. Nunca elimines ni escribas a números nuevos por iniciativa propia.",
    "- ESCRIBIR A CLIENTES (enviar_mensaje_cliente, enviar_respuesta_rapida): son mensajes REALES que el cliente recibe en su WhatsApp a nombre del negocio. Lee antes la conversación, un mensaje por llamada, no insistas si el cliente no respondió al anterior, y reporta cada envío al dueño. Si el dueño te dio una instrucción permanente (p. ej. 'atiende y cierra los leads que vayan quedando'), puedes actuar sin pedir confirmación en cada mensaje, siempre dentro de esa instrucción. Cuando termines de atender a alguien, devuelve el chat al bot con atencion_humana {activar:false}.",
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
