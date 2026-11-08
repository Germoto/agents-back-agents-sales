/**
 * Plantillas por rubro para cuentas NUEVAS: prompt base del agente, reglas,
 * tablero del CRM con columnas y etiquetas, respuestas rápidas y recordatorios.
 * Son textos neutros y editables; no fijan precios ni políticas comerciales
 * (eso lo escribe el dueño en su prompt). Se aplican una sola vez al crear la
 * cuenta y se reemplazan si el dueño cambia de rubro antes de tener productos.
 */
import type { BusinessVertical } from "@prisma/client";

export interface VerticalPreset {
  basePrompt: string;
  rules: string[];
  crm: { name: string; color: string; columns: { name: string; color?: string }[]; tags: { name: string; color: string }[] };
  quickReplies: { title: string; command: string; text: string }[];
  /** followupConfig del AgentConfig (misma forma que reminder-templates). */
  reminders: {
    abandonedCart: { enabled: boolean; steps: { delaySeconds: number; message: string; mediaUrl: null; mediaType: "" }[] };
    leftOnRead: { enabled: boolean; steps: { delaySeconds: number; message: string; mediaUrl: null; mediaType: "" }[] };
  };
}

const COMMON_RULES = ["Responde en español, breve y amable.", "No inventes precios, stock ni promociones: usa solo el catálogo."];

const STEP = (delaySeconds: number, message: string) => ({ delaySeconds, message, mediaUrl: null as null, mediaType: "" as const });

const PRESETS: Record<BusinessVertical, VerticalPreset> = {
  RESTAURANT: {
    basePrompt:
      "Eres el asistente de pedidos de un restaurante por WhatsApp. Saluda, ayuda a elegir de la carta, confirma cada plato con su precio, pregunta si es delivery o recojo, pide la dirección y la referencia cuando es delivery, indica el total y el tiempo estimado, y cobra según los métodos configurados. Si preguntan por un plato que no está en la carta, dilo con claridad y ofrece alternativas.",
    rules: [...COMMON_RULES, "Confirma el pedido completo (platos, cantidades, cremas o extras, dirección) antes de cobrar.", "Informa el tiempo de entrega y el costo de envío configurados."],
    crm: {
      name: "Pedidos",
      color: "#f59e0b",
      columns: [{ name: "Nuevos" }, { name: "Preparando" }, { name: "En camino" }, { name: "Entregados" }],
      tags: [{ name: "Delivery", color: "#3b82f6" }, { name: "Recojo", color: "#10b981" }, { name: "Cliente frecuente", color: "#8b5cf6" }],
    },
    quickReplies: [
      { title: "Carta de hoy", command: "carta", text: "¡Hola! 🍽️ Esta es nuestra carta de hoy. Dime qué se te antoja y te tomo el pedido." },
      { title: "Tiempo de entrega", command: "tiempo", text: "Tu pedido sale en unos minutos. El tiempo estimado de entrega es el que te indiqué al confirmar. ¡Gracias por la paciencia! 🙌" },
      { title: "Pedido en camino", command: "camino", text: "🛵 ¡Tu pedido ya está en camino! Cualquier cosa me escribes por aquí." },
    ],
    reminders: {
      abandonedCart: { enabled: true, steps: [STEP(45 * 60, "Hola {nombre} 👋 quedó pendiente tu pedido de {producto}. ¿Lo confirmo y lo preparamos? 🍽️")] },
      leftOnRead: { enabled: false, steps: [STEP(3600, "Hola {nombre} 👋 ¿seguimos con tu pedido? Te ayudo con lo que necesites.")] },
    },
  },
  PHYSICAL_GOODS: {
    basePrompt:
      "Eres el asistente de ventas de una tienda por WhatsApp. Ayuda a elegir el producto correcto (tallas, colores, modelos), confirma precio y disponibilidad, pide los datos de envío cuando el cliente confirme la compra, indica el total con el envío y cobra según los métodos configurados. Si un producto no está disponible, ofrece una alternativa parecida.",
    rules: [...COMMON_RULES, "Pide dirección y referencia solo cuando el cliente confirme la compra.", "Confirma variante (talla, color) antes de cobrar."],
    crm: {
      name: "Ventas",
      color: "#3b82f6",
      columns: [{ name: "Nuevos" }, { name: "Cotizando" }, { name: "Pagado" }, { name: "Enviado" }, { name: "Entregado" }],
      tags: [{ name: "Mayorista", color: "#8b5cf6" }, { name: "Provincia", color: "#f59e0b" }, { name: "Cliente frecuente", color: "#10b981" }],
    },
    quickReplies: [
      { title: "Catálogo", command: "catalogo", text: "¡Hola! 🛍️ Te paso nuestro catálogo. Dime qué producto te interesa y te confirmo disponibilidad." },
      { title: "Datos de envío", command: "envio", text: "Para enviarte el pedido necesito: nombre completo, dirección exacta, referencia y un número de contacto. 📦" },
      { title: "Pedido enviado", command: "enviado", text: "📦 ¡Tu pedido ya fue enviado! Te aviso apenas tenga el código de seguimiento." },
    ],
    reminders: {
      abandonedCart: { enabled: true, steps: [STEP(6 * 3600, "Hola {nombre} 👋 vi que quedó pendiente tu compra de {producto}. Sigue disponible, ¿te ayudo a completarla?")] },
      leftOnRead: { enabled: false, steps: [STEP(3600, "Hola {nombre} 👋 ¿seguimos? Cualquier duda sobre {producto} te ayudo encantado.")] },
    },
  },
  SERVICE: {
    basePrompt:
      "Eres el asistente de un negocio de servicios por WhatsApp. Explica los servicios, responde dudas, ofrece horarios disponibles y agenda la cita con nombre, servicio, fecha y hora. Confirma la modalidad (presencial o videollamada) y la dirección o el enlace según corresponda. Si piden algo fuera del horario, ofrece el siguiente horario disponible.",
    rules: [...COMMON_RULES, "Ofrece máximo tres horarios a la vez y confirma uno.", "Antes de agendar confirma nombre y servicio."],
    crm: {
      name: "Citas",
      color: "#10b981",
      columns: [{ name: "Nuevos" }, { name: "Cita agendada" }, { name: "Atendido" }, { name: "Seguimiento" }],
      tags: [{ name: "Primera vez", color: "#3b82f6" }, { name: "Reagendó", color: "#f59e0b" }, { name: "Frecuente", color: "#8b5cf6" }],
    },
    quickReplies: [
      { title: "Horarios", command: "horarios", text: "¡Hola! 📅 Atendemos en el horario configurado. Dime qué día te acomoda y te doy las horas disponibles." },
      { title: "Cómo llegar", command: "llegar", text: "📍 Te esperamos en nuestra dirección. Si vienes en auto o transporte público, avísame y te doy referencias." },
      { title: "Recordatorio de cita", command: "recordatorio", text: "Hola {nombre} 👋 te recuerdo tu cita de mañana. Si necesitas cambiarla, escríbeme por aquí." },
    ],
    reminders: {
      abandonedCart: { enabled: true, steps: [STEP(24 * 3600, "Hola {nombre} 👋 quedó pendiente tu cita de {producto}. ¿Te reservo un horario esta semana?")] },
      leftOnRead: { enabled: false, steps: [STEP(3600, "Hola {nombre} 👋 ¿te ayudo a elegir un horario para {producto}?")] },
    },
  },
  INFOPRODUCT: {
    basePrompt:
      "Eres el asistente de ventas de productos digitales (cursos, packs, accesos) por WhatsApp. Presenta el producto con sus beneficios, responde objeciones con honestidad, envía la muestra cuando la pidan, cobra según los métodos configurados y, validado el pago, entrega el acceso con las instrucciones configuradas.",
    rules: [...COMMON_RULES, "Entrega el acceso solo después de validar el pago.", "Si piden una muestra, envíala antes de insistir con el pago."],
    crm: {
      name: "Ventas",
      color: "#8b5cf6",
      columns: [{ name: "Nuevos" }, { name: "Interesados" }, { name: "Pagados" }, { name: "Entregados" }],
      tags: [{ name: "Pidió muestra", color: "#3b82f6" }, { name: "Objeción precio", color: "#f59e0b" }, { name: "Recompra", color: "#10b981" }],
    },
    quickReplies: [
      { title: "Qué incluye", command: "incluye", text: "¡Hola! 🎓 Te cuento qué incluye: contenido completo, acceso inmediato tras el pago y soporte por aquí. ¿Te paso una muestra?" },
      { title: "Cómo pagar", command: "pagar", text: "Puedes pagar por los métodos configurados. Me mandas la captura por aquí y te entrego el acceso al instante. ✅" },
      { title: "Acceso entregado", command: "acceso", text: "✅ ¡Listo! Ya tienes tu acceso. Cualquier duda con el material me escribes." },
    ],
    reminders: {
      abandonedCart: { enabled: true, steps: [STEP(6 * 3600, "Hola {nombre} 👋 vi que quedó pendiente tu compra de {producto}. ¿Te ayudo a completarla? Sigue disponible 🙌")] },
      leftOnRead: { enabled: false, steps: [STEP(3600, "Hola {nombre} 👋 ¿seguimos? Cualquier duda sobre {producto} te ayudo encantado.")] },
    },
  },
  REAL_ESTATE: {
    basePrompt:
      "Eres el asistente de una inmobiliaria por WhatsApp. Califica al interesado (compra o alquiler, zona, presupuesto, cuándo necesita mudarse), presenta los inmuebles del catálogo que encajen, responde dudas con los datos de la ficha y agenda la visita con fecha y hora. Deriva a un asesor cuando pidan negociar el precio o firmar.",
    rules: [...COMMON_RULES, "Pregunta zona y presupuesto antes de mostrar opciones.", "Agenda la visita confirmando nombre, inmueble, fecha y hora."],
    crm: {
      name: "Interesados",
      color: "#0ea5e9",
      columns: [{ name: "Nuevos" }, { name: "Calificado" }, { name: "Visita agendada" }, { name: "Propuesta" }, { name: "Cerrado" }],
      tags: [{ name: "Compra", color: "#3b82f6" }, { name: "Alquiler", color: "#10b981" }, { name: "Inversionista", color: "#8b5cf6" }],
    },
    quickReplies: [
      { title: "Ficha del inmueble", command: "ficha", text: "¡Hola! 🏠 Te paso la ficha del inmueble con fotos, área y precio. ¿Quieres agendar una visita?" },
      { title: "Agendar visita", command: "visita", text: "📅 Con gusto coordinamos la visita. ¿Qué día y hora te acomodan? Te confirmo en seguida." },
      { title: "Documentos", command: "documentos", text: "Para avanzar necesitaremos DNI y, según el caso, sustento de ingresos. Un asesor te acompaña en el proceso." },
    ],
    reminders: {
      abandonedCart: { enabled: true, steps: [STEP(24 * 3600, "Hola {nombre} 👋 ¿seguimos con la visita a {producto}? Tengo horarios disponibles esta semana.")] },
      leftOnRead: { enabled: false, steps: [STEP(2 * 3600, "Hola {nombre} 👋 ¿te quedó alguna duda sobre {producto}?")] },
    },
  },
  STREAMER: {
    basePrompt:
      "Eres el asistente de ventas de cuentas y suscripciones de streaming por WhatsApp. Presenta los planes con duración y precio, cobra según los métodos configurados y, validado el pago, entrega la credencial con las instrucciones configuradas. Recuerda las renovaciones cuando el sistema lo indique.",
    rules: [...COMMON_RULES, "Entrega credenciales solo después de validar el pago.", "Indica siempre la duración del plan."],
    crm: {
      name: "Suscripciones",
      color: "#ef4444",
      columns: [{ name: "Nuevos" }, { name: "Pagados" }, { name: "Activos" }, { name: "Por renovar" }],
      tags: [{ name: "Renovación", color: "#f59e0b" }, { name: "Nuevo", color: "#3b82f6" }, { name: "Problema de acceso", color: "#ef4444" }],
    },
    quickReplies: [
      { title: "Planes", command: "planes", text: "¡Hola! 📺 Estos son nuestros planes con su duración y precio. ¿Cuál te interesa?" },
      { title: "Renovar", command: "renovar", text: "Tu plan está por vencer. ¿Lo renovamos? Me mandas la captura del pago y lo activo al instante. 🔄" },
      { title: "Acceso entregado", command: "acceso", text: "✅ ¡Listo! Tu acceso está activo. Guarda bien tus datos y cualquier problema me escribes." },
    ],
    reminders: {
      abandonedCart: { enabled: true, steps: [STEP(3 * 3600, "Hola {nombre} 👋 quedó pendiente tu {producto}. ¿Lo activamos hoy?")] },
      leftOnRead: { enabled: false, steps: [STEP(3600, "Hola {nombre} 👋 ¿te ayudo a elegir un plan?")] },
    },
  },
  OTHER: {
    basePrompt:
      "Eres un agente vendedor por WhatsApp. Saluda, entiende qué necesita el cliente, presenta los productos o servicios del catálogo con su precio, responde dudas con honestidad, confirma el pedido y cobra según los métodos configurados.",
    rules: [...COMMON_RULES, "Pide datos de entrega solo cuando el cliente confirme la compra."],
    crm: {
      name: "Ventas",
      color: "#6366f1",
      columns: [{ name: "Nuevos" }, { name: "Interesados" }, { name: "Pagados" }],
      tags: [{ name: "Caliente", color: "#ef4444" }, { name: "Seguimiento", color: "#f59e0b" }],
    },
    quickReplies: [
      { title: "Saludo", command: "hola", text: "¡Hola! 👋 Gracias por escribirnos. Cuéntame qué necesitas y te ayudo." },
      { title: "Cómo pagar", command: "pagar", text: "Puedes pagar por los métodos configurados. Me mandas la captura por aquí y confirmo tu pedido. ✅" },
    ],
    reminders: {
      abandonedCart: { enabled: true, steps: [STEP(6 * 3600, "Hola {nombre} 👋 vi que quedó pendiente tu compra de {producto}. ¿Te ayudo a completarla?")] },
      leftOnRead: { enabled: false, steps: [STEP(3600, "Hola {nombre} 👋 ¿seguimos? Cualquier duda te ayudo encantado.")] },
    },
  },
};

export function presetFor(vertical: BusinessVertical | null | undefined): VerticalPreset {
  return PRESETS[(vertical ?? "OTHER") as BusinessVertical] ?? PRESETS.OTHER;
}

/** Prompt genérico que escribe provisionClient antes de aplicar la plantilla. */
export const LEGACY_DEFAULT_PROMPT =
  "Eres un agente vendedor por WhatsApp. Responde claro, breve y enfocado en cerrar la venta con honestidad.";
