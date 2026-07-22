/**
 * Agente de ventas de la PLATAFORMA: el chat del landing que atiende a
 * prospectos que quieren adquirir el SaaS. Vive como un tenant oculto
 * ("FlowApp Ventas", rubro OTHER, sin productos, pagos off, LEGACY) que
 * reutiliza TODO el runtime existente (agente IA, chat web, CRM,
 * conversaciones). Aquí: provisioning idempotente, base de conocimiento con
 * campos predefinidos y composición del basePrompt (con los paquetes públicos
 * inyectados en vivo al guardar).
 */

import crypto from "crypto";
import bcrypt from "bcrypt";
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
    "- Sirve para varios rubros: infoproductos, productos físicos, restaurantes, servicios con reserva, venta de cuentas de streaming y más.\n" +
    "- Panel web moderno (funciona como app en el celular), con conversaciones en tiempo real, comprobantes, dashboard de métricas y reportes automáticos.",
  comoEmpezar:
    "1) Crear la cuenta gratis en https://flowapp.pe/registro (toma 2 minutos).\n" +
    "2) Conectar su WhatsApp y cargar sus productos o servicios con fotos y precios.\n" +
    "3) Activar el agente: desde ese momento atiende, vende y valida pagos solo.\n" +
    "El sistema incluye una guía de activación paso a paso y un simulador para probar el agente antes de salir en vivo.",
  faq:
    "P: ¿Necesito la API oficial de WhatsApp?\nR: No es obligatorio. FlowApp funciona con un número de WhatsApp normal (vía SMS Tools) o, si lo prefieres, con la API oficial de Meta. Tú eliges el proveedor.\n\n" +
    "P: ¿Cómo valida los pagos por Yape o Plin?\nR: El cliente envía la captura de su constancia y la IA la lee (monto, código de seguridad); el sistema la cruza con las notificaciones de pago y aprueba automáticamente. Si algo no cuadra, deriva a una persona.\n\n" +
    "P: ¿Sirve para mi rubro?\nR: Sí: infoproductos, productos físicos con delivery, restaurantes, servicios con reserva de citas, venta de cuentas de streaming y otros. El agente se adapta al rubro configurado.\n\n" +
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

export function composeSalesAgentPrompt(
  knowledge: SalesAgentKnowledge,
  plans: Awaited<ReturnType<typeof listPublicPlans>>,
): string {
  const sections: string[] = [
    `Eres el ASISTENTE COMERCIAL de FlowApp (https://flowapp.pe), la plataforma de agentes de venta con IA para WhatsApp y web. Atiendes a PROSPECTOS interesados en adquirir FlowApp para su negocio, desde el chat del sitio oficial.`,
    `TU OBJETIVO: resolver sus dudas con la base de conocimiento, entender su negocio (pregunta a qué se dedica y qué vende) y llevarlo a CREAR SU CUENTA en https://flowapp.pe/registro. Si pide hablar con una persona, una demo personalizada o algo que no sabes, usa la herramienta derivar_humano.`,
    `REGLAS CRÍTICAS:\n- NO eres un vendedor de catálogo: NO uses enviar_ficha, enviar_catalogo, enviar_metodos_pago, validar_pago, entregar_producto, registrar_pedido ni agendar_servicio (no aplican aquí).\n- NUNCA inventes precios, funciones ni promesas: usa SOLO esta base de conocimiento.\n- Responde breve, claro y en el idioma del prospecto. Una pregunta a la vez.\n- Cuando notes interés real, comparte el link de registro: https://flowapp.pe/registro`,
    `=== QUÉ ES FLOWAPP ===\n${knowledge.queEs}`,
    `=== FUNCIONES PRINCIPALES ===\n${knowledge.funciones}`,
    `=== PLANES Y PRECIOS VIGENTES (actualizados automáticamente) ===\n${renderPlans(plans)}`,
    `=== CÓMO EMPEZAR ===\n${knowledge.comoEmpezar}`,
    `=== PREGUNTAS FRECUENTES ===\n${knowledge.faq}`,
    `=== CONTACTO HUMANO ===\n${knowledge.contacto}`,
  ];
  if (knowledge.extra.trim()) {
    sections.push(`=== INFORMACIÓN ADICIONAL ===\n${knowledge.extra}`);
  }
  return sections.join("\n\n");
}

function salesAgentRules(): string[] {
  return [
    "Eres informativo y consultivo: no vendes productos con fichas ni links de pago.",
    "Tu meta es que el prospecto cree su cuenta en https://flowapp.pe/registro.",
    "Si piden hablar con una persona o una demo, usa derivar_humano.",
    "No inventes precios ni funciones: usa solo la base de conocimiento.",
    "Pregunta a qué se dedica el negocio del prospecto para recomendar cómo le sirve FlowApp.",
  ];
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

export async function ensureSalesAgentTenant(superadmin: { id: string; phone: string }): Promise<string> {
  const pointer = await getSalesAgentPointer();
  if (pointer.companyId) {
    const exists = await prisma.company.findUnique({
      where: { id: pointer.companyId },
      select: { id: true },
    });
    if (exists) return pointer.companyId;
  }

  // ¿Quedó la Company de una corrida anterior sin puntero? Adoptarla.
  const bySlug = await prisma.company.findUnique({
    where: { slug: SALES_COMPANY_SLUG },
    select: { id: true },
  });
  if (bySlug) {
    await setSalesAgentPointer(bySlug.id, pointer.knowledge ?? { ...DEFAULT_KNOWLEDGE });
    return bySlug.id;
  }

  const phone = await uniqueSyntheticPhone();
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
  const basePrompt = composeSalesAgentPrompt(DEFAULT_KNOWLEDGE, await listPublicPlans());

  const company = await prisma.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: {
        name: SALES_COMPANY_NAME,
        slug: SALES_COMPANY_SLUG,
        adminPhone: superadmin.phone,
        vertical: "OTHER",
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
        basePrompt,
        salesStyle: "consultivo",
        rules: salesAgentRules(),
      },
    });

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
  const [pointer, agent, webchat] = await Promise.all([
    getSalesAgentPointer(),
    prisma.agentConfig.findUnique({
      where: { companyId },
      select: { openaiApiKey: true, openaiModel: true },
    }),
    prisma.webchatConfig.findUnique({
      where: { companyId },
      select: { enabled: true, token: true, welcomeMessage: true, accentColor: true },
    }),
  ]);
  return {
    companyId,
    knowledge: normalizeKnowledge(pointer.knowledge),
    knowledgeFields: KNOWLEDGE_FIELDS,
    apiKeySet: !!agent?.openaiApiKey,
    openaiModel: agent?.openaiModel ?? "gpt-4.1-mini",
    webchat: {
      enabled: webchat?.enabled ?? false,
      token: webchat?.token ?? "",
      welcomeMessage: webchat?.welcomeMessage ?? DEFAULT_WELCOME,
      accentColor: webchat?.accentColor ?? "#7c3aed",
    },
  };
}

export async function updateSalesAgentAdmin(
  superadmin: { id: string; phone: string },
  data: {
    knowledge?: Partial<SalesAgentKnowledge>;
    openaiApiKey?: string;
    openaiModel?: string;
    enabled?: boolean;
    welcomeMessage?: string;
    accentColor?: string;
  },
) {
  const companyId = await ensureSalesAgentTenant(superadmin);
  const pointer = await getSalesAgentPointer();
  const knowledge = normalizeKnowledge({
    ...(pointer.knowledge ?? {}),
    ...(data.knowledge ?? {}),
  });

  // Re-componer SIEMPRE el prompt al guardar: refresca conocimiento y precios.
  const basePrompt = composeSalesAgentPrompt(knowledge, await listPublicPlans());

  await prisma.agentConfig.update({
    where: { companyId },
    data: {
      basePrompt,
      rules: salesAgentRules(),
      ...(data.openaiApiKey && data.openaiApiKey.trim() ? { openaiApiKey: data.openaiApiKey.trim() } : {}),
      ...(data.openaiModel ? { openaiModel: data.openaiModel } : {}),
    },
  });

  await prisma.webchatConfig.update({
    where: { companyId },
    data: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.welcomeMessage !== undefined ? { welcomeMessage: data.welcomeMessage } : {}),
      ...(data.accentColor !== undefined ? { accentColor: data.accentColor } : {}),
    },
  });

  await setSalesAgentPointer(companyId, knowledge as unknown as Record<string, string>);
  return getSalesAgentAdmin(superadmin);
}
