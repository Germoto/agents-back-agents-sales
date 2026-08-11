/**
 * Agente de ventas de la PLATAFORMA: el chat del landing que atiende a
 * prospectos que quieren adquirir el SaaS. Vive como un tenant oculto
 * ("FlowApp Ventas", rubro SERVICE, pagos off, LEGACY) que reutiliza TODO el
 * runtime existente (agente IA, chat web, CRM, conversaciones, agenda de demos).
 *
 * REDISEÑO "tenant total": la base de conocimiento vive en el PRODUCTO
 * "FlowApp" del catálogo del tenant (ficha editable en Productos impersonando);
 * los paquetes públicos y precios se inyectan al prompt EN VIVO en cada turno
 * (getLivePlansPromptSection, consumido por buildBotConfig); el basePrompt es
 * una identidad LEAN. La consola solo conserva el toggle de la burbuja del
 * landing y los accesos por impersonación.
 */

import crypto from "crypto";
import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import {
  getSalesAgentPointer,
  setSalesAgentPointer,
} from "../platform-config/platform-config.service";
import { newWidgetToken } from "../webchat/webchat.service";
import { listPublicPlans } from "../billing/billing.service";

const SALES_COMPANY_SLUG = "flowapp-ventas";
const SALES_COMPANY_NAME = "FlowApp Ventas";
const DEFAULT_WELCOME =
  "¡Hola! 👋 Soy el asistente de FlowApp. ¿Quieres saber cómo un agente IA puede vender por ti en WhatsApp y en tu web? Pregúntame lo que necesites.";

// ---------------------------------------------------------------------------
// Base de conocimiento: campos predefinidos (editables desde la consola)
// ---------------------------------------------------------------------------

export interface SalesAgentKnowledge {
  queEs: string;
  funciones: string;
  comoEmpezar: string;
  faq: string;
  contacto: string;
  extra: string;
}

export const KNOWLEDGE_FIELDS: Array<{ key: keyof SalesAgentKnowledge; label: string; hint: string }> = [
  { key: "queEs", label: "¿Qué es FlowApp?", hint: "Presentación corta del producto." },
  { key: "funciones", label: "Funciones principales", hint: "Todo lo que el sistema puede hacer." },
  { key: "comoEmpezar", label: "Cómo empezar", hint: "Registro, activación y primeros pasos." },
  { key: "faq", label: "Preguntas frecuentes", hint: "Formato P: / R: — una por bloque." },
  { key: "contacto", label: "Contacto humano", hint: "Cómo comunicarse con el equipo (WhatsApp, horario)." },
  { key: "extra", label: "Información adicional", hint: "Cualquier otro contexto (promociones, políticas…)." },
];

export const DEFAULT_KNOWLEDGE: SalesAgentKnowledge = {
  queEs:
    "FlowApp (https://flowapp.pe) es una plataforma SaaS que le da a cualquier negocio un AGENTE DE VENTAS con INTELIGENCIA ARTIFICIAL que atiende por WhatsApp y por un chat incrustado en su página web. El agente conversa con los clientes 24/7 como un vendedor humano: presenta los productos o servicios, resuelve dudas, cobra, valida los pagos automáticamente y entrega el producto, mientras el dueño ve todo en un panel en tiempo real.",
  funciones:
    "- Agente IA 24/7 por WhatsApp (funciona con número normal vía SMS Tools o con la API oficial de Meta) y por chat web incrustable en cualquier página (widget de una línea de código).\n" +
    "- Venta completa en el chat: presenta fichas con fotos/PDF, arma el carrito, envía métodos de pago y cierra la venta.\n" +
    "- Validación AUTOMÁTICA de pagos: lee la constancia de Yape/Plin con visión artificial y aprueba el pago solo; también genera links de Mercado Pago (tarjeta, banco, Yape) con entrega automática al confirmar.\n" +
    "- Entrega automática de productos digitales (cursos, ebooks, accesos, cuentas de streaming) apenas se confirma el pago.\n" +
    "- CRM kanban en vivo: cada chat avanza solo por el embudo (nuevo → interesado → pagado); tableros múltiples, etiquetas y valor de negocio.\n" +
    "- Campañas masivas de WhatsApp con protección anti-bloqueo (pausas inteligentes, horarios, límite diario), importación desde Excel y resultados detallados.\n" +
    "- Flujos de chatbot guiados (menús con botones) como alternativa o complemento del agente IA, con editor visual.\n" +
    "- Recordatorios y seguimientos automáticos: carritos abandonados, clientes que dejan en visto, post-venta y vencimientos de suscripciones.\n" +
    "- Sirve para varios rubros: infoproductos, productos físicos, restaurantes, servicios con reserva, inmobiliarias (visitas a inmuebles), venta de cuentas de streaming y más.\n" +
    "- Panel web moderno (funciona como app en el celular), con conversaciones en tiempo real, comprobantes, dashboard de métricas y reportes automáticos.",
  comoEmpezar:
    "1) Crear la cuenta gratis en https://flowapp.pe/registro (toma 2 minutos).\n" +
    "2) Conectar su WhatsApp y cargar sus productos o servicios con fotos y precios.\n" +
    "3) Activar el agente: desde ese momento atiende, vende y valida pagos solo.\n" +
    "El sistema incluye una guía de activación paso a paso y un simulador para probar el agente antes de salir en vivo.",
  faq:
    "P: ¿Necesito la API oficial de WhatsApp?\nR: No es obligatorio. FlowApp funciona con un número de WhatsApp normal (vía SMS Tools) o, si lo prefieres, con la API oficial de Meta. Tú eliges el proveedor.\n\n" +
    "P: ¿Cómo valida los pagos por Yape o Plin?\nR: El cliente envía la captura de su constancia y la IA la lee (monto, código de seguridad); el sistema la cruza con las notificaciones de pago y aprueba automáticamente. Si algo no cuadra, deriva a una persona.\n\n" +
    "P: ¿Sirve para mi rubro?\nR: Sí: infoproductos, productos físicos con delivery, restaurantes, servicios con reserva de citas, inmobiliarias que agendan visitas, venta de cuentas de streaming y otros. El agente se adapta al rubro configurado.\n\n" +
    "P: ¿Puedo probarlo antes de pagar?\nR: Sí, puedes crear tu cuenta y probar el agente con el simulador y este mismo chat es un ejemplo del agente funcionando.\n\n" +
    "P: ¿Puedo atender yo mismo algunas conversaciones?\nR: Sí. Puedes pausar el bot en cualquier chat y responder tú desde el panel (atención humana), y reactivarlo cuando quieras.",
  contacto:
    "Para hablar con una persona del equipo de FlowApp, deriva la conversación a un asesor humano. También pueden escribirnos por WhatsApp (el número del equipo se comparte al derivar).",
  extra: "",
};

// ---------------------------------------------------------------------------
// Composición del basePrompt (identidad + conocimiento + planes vivos)
// ---------------------------------------------------------------------------

const MODULE_LABELS: Record<string, string> = {
  CRM: "CRM kanban",
  CAMPAIGNS: "Campañas masivas",
  FUNNEL: "Embudo de ventas",
  FLOWS: "Flujos de chatbot",
  QUICK_REPLIES: "Respuestas rápidas",
  META_PROVIDER: "API oficial de Meta WhatsApp",
  WEBCHAT: "Chat web con agente IA",
  MERCADOPAGO: "Links de pago con Mercado Pago",
  REPORTS: "Reportes automáticos",
  WEBHOOKS: "Webhooks / API de integraciones",
};

function renderPlans(plans: Awaited<ReturnType<typeof listPublicPlans>>): string {
  if (!plans.length) {
    return "Actualmente los planes se cotizan directamente con el equipo: invita al prospecto a registrarse o a hablar con un asesor.";
  }
  return plans
    .map((p) => {
      const price = p.pricePen > 0 ? `S/ ${p.pricePen}/mes` : p.priceUsd > 0 ? `USD ${p.priceUsd}/mes` : "Gratis";
      const leads = p.monthlyLeadLimit ? `${p.monthlyLeadLimit} leads/mes` : "leads ilimitados";
      const extra =
        p.extraLeadPricePen !== null ? `; lead extra S/ ${p.extraLeadPricePen}` : "";
      const mods = (p.modules ?? []).map((m: string) => MODULE_LABELS[m] ?? m).join(", ");
      return `- ${p.name}: ${price} (${leads}${extra})${mods ? `. Incluye: ${mods}` : ""}${p.description ? `. ${p.description}` : ""}`;
    })
    .join("\n");
}

/** Versión anterior del prompt lean — SOLO para el touch-up de actualización:
 * si el basePrompt del tenant sigue siendo EXACTAMENTE este, se reemplaza por
 * la versión vigente; si el dueño lo editó a mano, no se toca. */
const SALES_AGENT_LEAN_PROMPT_V1 = [
  "Eres el ASESOR COMERCIAL de FlowApp (https://flowapp.pe), la plataforma que le da a cualquier negocio un agente de ventas con IA para WhatsApp y chat web. Atiendes a PROSPECTOS desde el chat del sitio oficial.",
  "REGLAS:",
  "- Toda la información sobre FlowApp está en tu catálogo: usa enviar_ficha para presentarlo y responde con su base de conocimiento (descripción, beneficios, FAQs). No inventes funciones ni promesas.",
  "- Los planes y precios vigentes aparecen en la sección 'PLANES Y PRECIOS VIGENTES'. Usa SOLO esos datos; nunca inventes precios ni descuentos.",
  "- NO cobras por este chat: para contratar, dirige SIEMPRE a https://flowapp.pe/registro. Nunca envíes métodos de pago ni valides comprobantes.",
  "- Tu objetivo es resolver dudas, entender el negocio del prospecto (pregunta a qué se dedica) y llevarlo a crear su cuenta. Capta su interés con naturalidad.",
  "- Si quiere ver la plataforma en acción, ofrécele agendar una demo SOLO si hay disponibilidad configurada (consultar_disponibilidad); si no hay agenda, invítalo a probar el simulador creando su cuenta.",
  "- Si pide hablar con una persona o algo fuera de tu alcance, usa derivar_humano.",
  "- Tono cercano, profesional y directo. Respuestas cortas (2-4 oraciones), en el idioma del prospecto. Una pregunta a la vez.",
].join("\n");

/**
 * Identidad LEAN del asesor comercial (versión vigente, enruta por intención).
 * El conocimiento vive en el producto "FlowApp" del catálogo y los precios
 * llegan por la sección viva de planes que inyecta buildBotConfig en cada turno.
 */
/** Versión 2 congelada — solo para el touch-up de actualización. */
const SALES_AGENT_LEAN_PROMPT_V2 = [
  "Eres el ASESOR COMERCIAL de FlowApp (https://flowapp.pe), la plataforma que le da a cualquier negocio un agente de ventas con IA para WhatsApp y chat web. Atiendes a PROSPECTOS desde el chat del sitio oficial.",
  "REGLAS:",
  "- RESPONDE a LO QUE EL PROSPECTO ESCRIBIÓ, nunca con un guion fijo: si pregunta PRECIOS o planes, escríbele TÚ los planes de la sección 'PLANES Y PRECIOS VIGENTES' (montos exactos, en tu propio texto, SIN enviar la ficha). Si pregunta qué es FlowApp o pide información general, preséntalo con enviar_ficha — UNA sola vez por conversación, nunca la repitas. Si SOLO saluda, salúdalo breve y pregúntale a qué se dedica su negocio (sin presentar todavía).",
  "- Las demás dudas se responden con la base de conocimiento del catálogo (descripción, beneficios, FAQs). No inventes funciones, precios ni promesas. NUNCA digas que 'enviaste' información o precios si no los escribiste en tu mensaje.",
  "- NO cobras por este chat: para contratar, dirige SIEMPRE a https://flowapp.pe/registro. Nunca envíes métodos de pago ni valides comprobantes.",
  "- Tu objetivo es resolver dudas, entender el negocio del prospecto (pregunta a qué se dedica) y llevarlo a crear su cuenta. Capta su interés con naturalidad.",
  "- Si quiere ver la plataforma en acción, ofrécele agendar una demo SOLO si hay disponibilidad configurada (consultar_disponibilidad); si no hay agenda, invítalo a probar el simulador creando su cuenta.",
  "- Si pide hablar con una persona o algo fuera de tu alcance, usa derivar_humano.",
  "- Tono cercano, profesional y directo. Respuestas cortas (2-4 oraciones), en el idioma del prospecto. Una pregunta a la vez.",
].join("\n");

export const SALES_AGENT_LEAN_PROMPT = [
  "Eres el ASESOR COMERCIAL de FlowApp (https://flowapp.pe), la plataforma que le da a cualquier negocio un agente de ventas con IA para WhatsApp y chat web. Atiendes a PROSPECTOS desde el chat del sitio oficial.",
  "REGLAS:",
  "- RESPONDE a LO QUE EL PROSPECTO ESCRIBIÓ, nunca con un guion fijo: si pregunta PRECIOS o planes, escríbele TÚ los planes de la sección 'PLANES Y PRECIOS VIGENTES' (montos exactos, en tu propio texto, SIN enviar la ficha). Si pregunta qué es FlowApp o pide información general, preséntalo con enviar_ficha — UNA sola vez por conversación, nunca la repitas. Si SOLO saluda, salúdalo breve y pregúntale a qué se dedica su negocio (sin presentar todavía).",
  "- Las demás dudas se responden con la base de conocimiento del catálogo (descripción, beneficios, FAQs). No inventes funciones, precios ni promesas. NUNCA digas que 'enviaste' información o precios si no los escribiste en tu mensaje.",
  "- NO cobras por este chat: para contratar, dirige SIEMPRE a https://flowapp.pe/registro. Nunca envíes métodos de pago ni valides comprobantes.",
  "- Tu objetivo es resolver dudas, entender el negocio del prospecto (pregunta a qué se dedica) y llevarlo a crear su cuenta. Capta su interés con naturalidad.",
  "- Si quiere ver la plataforma en acción, ofrécele agendar una demo SOLO si hay disponibilidad configurada (consultar_disponibilidad); si no hay agenda, invítalo a probar el simulador creando su cuenta.",
  "- Si pide hablar con una persona, usa derivar_humano. NUNCA derives por falta de horarios de demo ni por preguntas que puedes responder: si no hay horarios disponibles, ofrece dejar la solicitud de demo registrada (agendar_servicio con requestedText) o pide su WhatsApp y dile que el equipo lo contactará. Nunca dejes al prospecto sin salida.",
  "- Tono cercano, profesional y directo. Respuestas cortas (2-4 oraciones), en el idioma del prospecto. Una pregunta a la vez.",
].join("\n");

function salesAgentRules(): string[] {
  return [
    "Tu meta es que el prospecto cree su cuenta en https://flowapp.pe/registro.",
    "No cobras por el chat: nunca envíes métodos de pago; dirige al registro.",
    "Si piden hablar con una persona, usa derivar_humano.",
    "No inventes precios ni funciones: usa el catálogo y la sección de planes vigentes.",
    "Pregunta a qué se dedica el negocio del prospecto para recomendar cómo le sirve FlowApp.",
  ];
}

// ---------------------------------------------------------------------------
// Inyección EN VIVO de planes al prompt (consumida por buildBotConfig)
// ---------------------------------------------------------------------------

/** ¿companyId es el tenant oculto del agente de ventas de la plataforma? */
export async function isPlatformSalesCompanyId(companyId: string): Promise<boolean> {
  const pointer = await getSalesAgentPointer();
  return !!pointer.companyId && pointer.companyId === companyId;
}

/** Sección de planes/precios ACTUALES para anexar al basePrompt en cada turno. */
export async function getLivePlansPromptSection(): Promise<string> {
  const plans = await listPublicPlans();
  return `\n\n=== PLANES Y PRECIOS VIGENTES (fuente oficial, usa SOLO estos) ===\n${renderPlans(plans)}`;
}

// ---------------------------------------------------------------------------
// Mapeo knowledge → producto "FlowApp" (seed único del rediseño)
// ---------------------------------------------------------------------------

interface KnowledgeProductSeed {
  shortDescription: string;
  fullDescription: string;
  benefits: string[];
  faqs: Array<{ question: string; answer: string }>;
}

/** Convierte la base de conocimiento legacy en la ficha del producto. Nunca pierde texto. */
export function mapKnowledgeToProduct(k: SalesAgentKnowledge): KnowledgeProductSeed {
  const firstSentence = k.queEs.split(/(?<=\.)\s/)[0]?.slice(0, 180) || k.queEs.slice(0, 180);
  const fullParts: string[] = [k.queEs];

  // funciones → beneficios (líneas con viñeta); sin viñetas → sección de texto.
  const bulletLines = k.funciones
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s+/.test(l))
    .map((l) => l.replace(/^[-•*]\s+/, "").trim())
    .filter(Boolean);
  if (!bulletLines.length && k.funciones.trim()) {
    fullParts.push(`## Qué hace\n${k.funciones.trim()}`);
  }

  // faq → pares P/R (heurística); si no parsea, el texto cae íntegro a la descripción.
  const faqs: Array<{ question: string; answer: string }> = [];
  let currentQ: string | null = null;
  let currentA: string[] = [];
  for (const raw of k.faq.split("\n")) {
    const line = raw.trim();
    const qMatch = line.match(/^(?:P:\s*)?(¿.+|.+\?)$/);
    if (qMatch && (line.startsWith("P:") || line.startsWith("¿") || line.endsWith("?"))) {
      if (currentQ && currentA.length) faqs.push({ question: currentQ, answer: currentA.join("\n").trim() });
      currentQ = qMatch[1].trim();
      currentA = [];
    } else if (line) {
      currentA.push(line.replace(/^R:\s*/, ""));
    }
  }
  if (currentQ && currentA.length) faqs.push({ question: currentQ, answer: currentA.join("\n").trim() });
  if (!faqs.length && k.faq.trim()) {
    fullParts.push(`## Preguntas frecuentes\n${k.faq.trim()}`);
  }
  if (k.comoEmpezar.trim()) {
    faqs.push({ question: "¿Cómo empiezo a usar FlowApp?", answer: k.comoEmpezar.trim() });
  }

  if (k.contacto.trim()) fullParts.push(`## Contacto\n${k.contacto.trim()}`);
  if (k.extra.trim()) fullParts.push(k.extra.trim());

  return {
    shortDescription: firstSentence,
    fullDescription: fullParts.join("\n\n"),
    benefits: bulletLines,
    faqs,
  };
}

function normalizeKnowledge(value: unknown): SalesAgentKnowledge {
  const raw = (value ?? {}) as Partial<Record<keyof SalesAgentKnowledge, unknown>>;
  const pick = (key: keyof SalesAgentKnowledge) =>
    typeof raw[key] === "string" && (raw[key] as string).trim() !== ""
      ? (raw[key] as string)
      : DEFAULT_KNOWLEDGE[key];
  return {
    queEs: pick("queEs"),
    funciones: pick("funciones"),
    comoEmpezar: pick("comoEmpezar"),
    faq: pick("faq"),
    contacto: pick("contacto"),
    extra: typeof raw.extra === "string" ? (raw.extra as string) : "",
  };
}

// ---------------------------------------------------------------------------
// Provisioning idempotente del tenant oculto
// ---------------------------------------------------------------------------

/** Phone sintético único para el User ADMIN del tenant (solo para impersonar). */
async function uniqueSyntheticPhone(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const candidate = `000${crypto.randomInt(100000000, 999999999)}`;
    const clash = await prisma.user.findUnique({ where: { phone: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }
  throw new AppError("No se pudo generar un teléfono único para el tenant de plataforma", 500);
}

/** Presentación CORTA que envía enviar_ficha (en vez de la ficha autogenerada larga). */
const SALES_PRODUCT_PRESENTATION =
  "🤖 *FlowApp* es tu agente de ventas con IA: atiende por WhatsApp y chat web 24/7, presenta tus productos, cobra, valida pagos (Yape/Plin/Mercado Pago) y entrega solo — mientras tú ves todo en un panel. Cuéntame, ¿qué vende tu negocio? Así te digo exactamente cómo te ayudaría 😊";

const SALES_PRODUCT_SLUG = "flowapp-agente-de-ventas-ia";

/** Crea el producto "FlowApp" del catálogo del tenant a partir del knowledge. */
async function createFlowAppProduct(
  tx: Prisma.TransactionClient,
  companyId: string,
  knowledge: SalesAgentKnowledge,
): Promise<void> {
  const seed = mapKnowledgeToProduct(knowledge);
  await tx.product.create({
    data: {
      companyId,
      slug: SALES_PRODUCT_SLUG,
      name: "FlowApp — Agente de ventas IA",
      productType: "DIGITAL",
      price: "Según el plan elegido",
      presentationMessage: SALES_PRODUCT_PRESENTATION,
      shortDescription: seed.shortDescription,
      fullDescription: seed.fullDescription,
      showInCatalog: true,
      active: true,
      benefits: { create: seed.benefits.map((value, i) => ({ value, sortOrder: i })) },
      faqs: { create: seed.faqs.map((f, i) => ({ question: f.question, answer: f.answer, sortOrder: i })) },
      aliases: {
        create: ["flowapp", "agente de ventas", "chatbot", "asistente ia", "agente ia"].map((value) => ({ value })),
      },
    },
  });
}

/**
 * Upgrade IDEMPOTENTE del tenant legacy (rediseño "tenant total"): pasa a
 * vertical SERVICE, seedea el producto FlowApp desde el knowledge de
 * PlatformConfig (solo si el catálogo está vacío) y reescribe el basePrompt a
 * la identidad lean UNA sola vez. El marcador es el vertical: si ya es
 * SERVICE, no se toca nada (protege ediciones posteriores del dueño).
 */
async function upgradeLegacyTenant(companyId: string): Promise<void> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { vertical: true } });
  if (!company || company.vertical === "SERVICE") return;

  const pointer = await getSalesAgentPointer();
  const knowledge = normalizeKnowledge(pointer.knowledge);

  await prisma.$transaction(async (tx) => {
    // Releer el vertical DENTRO de la transacción (carrera doble GET benigna).
    const fresh = await tx.company.findUnique({ where: { id: companyId }, select: { vertical: true } });
    if (!fresh || fresh.vertical === "SERVICE") return;
    await tx.company.update({ where: { id: companyId }, data: { vertical: "SERVICE" } });
    const productCount = await tx.product.count({ where: { companyId } });
    if (productCount === 0) {
      await createFlowAppProduct(tx, companyId, knowledge);
    }
    await tx.agentConfig.update({
      where: { companyId },
      data: { basePrompt: SALES_AGENT_LEAN_PROMPT, rules: salesAgentRules() },
    });
  });
  console.info("[sales-agent] tenant de plataforma actualizado a SERVICE + producto FlowApp");
}

/**
 * Touch-up idempotente: si el producto de plataforma quedó sin mensaje de
 * presentación (migración previa a este fix), setear el corto. No pisa
 * ediciones del dueño (solo escribe si está vacío).
 */
async function ensureProductPresentation(companyId: string): Promise<void> {
  await prisma.product.updateMany({
    where: {
      companyId,
      slug: SALES_PRODUCT_SLUG,
      OR: [{ presentationMessage: null }, { presentationMessage: "" }],
    },
    data: { presentationMessage: SALES_PRODUCT_PRESENTATION },
  });
}

/**
 * Touch-up idempotente del prompt: solo si el basePrompt sigue siendo
 * EXACTAMENTE la versión anterior generada por el sistema se actualiza a la
 * vigente. Si el dueño lo editó a mano, no se toca.
 */
async function ensureAgentPromptCurrent(companyId: string): Promise<void> {
  const agent = await prisma.agentConfig.findUnique({
    where: { companyId },
    select: { basePrompt: true },
  });
  const isSystemVersion =
    agent?.basePrompt === SALES_AGENT_LEAN_PROMPT_V1 || agent?.basePrompt === SALES_AGENT_LEAN_PROMPT_V2;
  if (isSystemVersion && agent?.basePrompt !== SALES_AGENT_LEAN_PROMPT) {
    await prisma.agentConfig.update({
      where: { companyId },
      data: { basePrompt: SALES_AGENT_LEAN_PROMPT },
    });
    console.info("[sales-agent] basePrompt del tenant de plataforma actualizado a la versión vigente");
  }
}

/**
 * Touch-ups del tenant de plataforma al ARRANCAR el backend (best-effort):
 * aplican en cada deploy sin depender de que alguien abra la consola. Solo
 * tocan el tenant apuntado por PlatformConfig — jamás a otra empresa.
 */
export async function ensureSalesAgentBootTouchups(): Promise<void> {
  try {
    const pointer = await getSalesAgentPointer();
    if (!pointer.companyId) return;
    await ensureProductPresentation(pointer.companyId);
    await ensureAgentPromptCurrent(pointer.companyId);
  } catch {
    // best-effort: nunca bloquear el boot
  }
}

export async function ensureSalesAgentTenant(superadmin: { id: string; phone: string }): Promise<string> {
  const pointer = await getSalesAgentPointer();
  if (pointer.companyId) {
    const exists = await prisma.company.findUnique({
      where: { id: pointer.companyId },
      select: { id: true },
    });
    if (exists) {
      await upgradeLegacyTenant(pointer.companyId);
      await ensureProductPresentation(pointer.companyId);
      await ensureAgentPromptCurrent(pointer.companyId);
      return pointer.companyId;
    }
  }

  // ¿Quedó la Company de una corrida anterior sin puntero? Adoptarla.
  const bySlug = await prisma.company.findUnique({
    where: { slug: SALES_COMPANY_SLUG },
    select: { id: true },
  });
  if (bySlug) {
    await setSalesAgentPointer(bySlug.id, pointer.knowledge ?? { ...DEFAULT_KNOWLEDGE });
    await upgradeLegacyTenant(bySlug.id);
    return bySlug.id;
  }

  const phone = await uniqueSyntheticPhone();
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);

  const company = await prisma.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: {
        name: SALES_COMPANY_NAME,
        slug: SALES_COMPANY_SLUG,
        adminPhone: superadmin.phone,
        vertical: "SERVICE",
        timezone: "America/Lima",
        isActive: true,
      },
      select: { id: true },
    });

    // User ADMIN: solo para la impersonación 1-clic desde la consola.
    await tx.user.create({
      data: {
        companyId: created.id,
        name: SALES_COMPANY_NAME,
        phone,
        passwordHash,
        role: "ADMIN",
        isActive: true,
      },
    });

    await tx.agentConfig.create({
      data: {
        companyId: created.id,
        openaiModel: "gpt-4.1-mini",
        openaiApiKey: "",
        temperature: "0.25",
        basePrompt: SALES_AGENT_LEAN_PROMPT,
        salesStyle: "consultivo",
        rules: salesAgentRules(),
      },
    });

    // La base de conocimiento vive en el producto FlowApp del catálogo.
    await createFlowAppProduct(tx, created.id, DEFAULT_KNOWLEDGE);

    // buildBotConfig exige la fila (los cobros quedan APAGADOS: agente informativo).
    await tx.paymentConfig.create({
      data: {
        companyId: created.id,
        enabled: false,
        paymentMode: "MANUAL",
      },
    });

    // buildBotConfig exige una WhatsappConfig activa. Fila inerte (sin account):
    // loadWhatsappSender devuelve null → el turno web funciona y los avisos por
    // WhatsApp simplemente se omiten.
    await tx.whatsappConfig.create({
      data: {
        companyId: created.id,
        apiUrl: env.SMSTOOLS_API_URL,
        secret: "",
        isActive: true,
      },
    });

    await tx.webchatConfig.create({
      data: {
        companyId: created.id,
        enabled: true,
        token: newWidgetToken(),
        welcomeMessage: DEFAULT_WELCOME,
        accentColor: "#7c3aed",
      },
    });

    // CRM de leads con embudo básico listo para usar.
    const crm = await tx.crm.create({
      data: { companyId: created.id, name: "Leads FlowApp", color: "#7c3aed", sortOrder: 0 },
      select: { id: true },
    });
    const columns = ["Nuevos", "Contactados", "Interesados", "Clientes"];
    for (let i = 0; i < columns.length; i++) {
      await tx.crmColumn.create({
        data: { crmId: crm.id, companyId: created.id, name: columns[i], sortOrder: i },
      });
    }

    return created;
  });

  await setSalesAgentPointer(company.id, { ...DEFAULT_KNOWLEDGE });
  return company.id;
}

// ---------------------------------------------------------------------------
// Lectura / escritura desde la consola superadmin
// ---------------------------------------------------------------------------

export async function getSalesAgentAdmin(superadmin: { id: string; phone: string }) {
  const companyId = await ensureSalesAgentTenant(superadmin);
  const [agent, webchat] = await Promise.all([
    prisma.agentConfig.findUnique({
      where: { companyId },
      select: { openaiApiKey: true },
    }),
    prisma.webchatConfig.findUnique({
      where: { companyId },
      select: { enabled: true },
    }),
  ]);
  const apiKeySet = !!agent?.openaiApiKey;
  const enabled = webchat?.enabled ?? false;
  return {
    companyId,
    enabled,
    apiKeySet,
    status: !enabled ? "disabled" : !apiKeySet ? "missing_key" : "active",
  };
}

/** Consola mínima: solo el toggle de la burbuja del landing. Todo lo demás se
 * edita impersonando el tenant (Agente IA, Productos, Chat Web). */
export async function updateSalesAgentAdmin(
  superadmin: { id: string; phone: string },
  data: { enabled: boolean },
) {
  const companyId = await ensureSalesAgentTenant(superadmin);
  await prisma.webchatConfig.update({
    where: { companyId },
    data: { enabled: data.enabled },
  });
  return getSalesAgentAdmin(superadmin);
}
