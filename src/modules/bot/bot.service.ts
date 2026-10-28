import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";
import { resolveAiSettings } from "../../lib/ai-providers";
import { mapBotProduct, productRelations } from "../../lib/product";
import { symbolFor } from "../../lib/currency";
import { isPlatformSalesCompanyId, getLivePlansPromptSection } from "../admin-console/sales-agent.service";
import { listCrmStructure } from "../crm/crm.service";
import { getEntitlements } from "../billing/entitlements";
import { LEGACY_UNKNOWN_HANDOFF_RULE, type CrmToolConfig } from "../agent-config/agent-config.schemas";

/** Herramienta de CRM del agente resuelta con NOMBRES (lo que lee el prompt y la tool). */
export interface AgentCrmTool {
  enabled: boolean;
  board: { id: string; name: string };
  columns: Array<{ id: string; name: string; sortOrder: number; when: string }>;
  addTags: Array<{ id: string; name: string; when: string }>;
  removeTags: Array<{ id: string; name: string }>;
  onlyForward: boolean;
  maxPerTurn: number;
  notifyOwner: boolean;
}

/**
 * Resuelve crmToolConfig (ids) → nombres reales, descartando columnas/etiquetas
 * que ya no existen. Devuelve null si está apagada, sin módulo CRM o sin nada
 * permitido (así la tool no se expone y el prompt no cambia).
 */
async function resolveAgentCrmTool(companyId: string, raw: unknown): Promise<AgentCrmTool | null> {
  const cfg = raw && typeof raw === "object" ? (raw as Partial<CrmToolConfig>) : null;
  if (!cfg?.enabled || !cfg.crmId) return null;
  const ent = await getEntitlements(companyId);
  if (!ent.legacy && !ent.modules.includes("CRM")) return null;
  const { boards, tags } = await listCrmStructure(companyId);
  const board = boards.find((b) => b.id === cfg.crmId);
  if (!board) return null;
  const columns = (cfg.columns ?? [])
    .map((c) => {
      const col = board.columns.find((x) => x.id === c.columnId);
      return col ? { id: col.id, name: col.name, sortOrder: col.sortOrder, when: c.when } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const addTags = (cfg.addTags ?? [])
    .map((t) => {
      const tag = tags.find((x) => x.id === t.tagId);
      return tag ? { id: tag.id, name: tag.name, when: t.when } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const removeTags = (cfg.removeTagIds ?? [])
    .map((id) => tags.find((x) => x.id === id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((t) => ({ id: t.id, name: t.name }));
  if (!columns.length && !addTags.length) return null;
  return {
    enabled: true,
    board: { id: board.id, name: board.name },
    columns,
    addTags,
    removeTags,
    onlyForward: cfg.onlyForward !== false,
    maxPerTurn: Math.min(3, Math.max(1, Number(cfg.maxPerTurn) || 1)),
    notifyOwner: cfg.notifyOwner !== false,
  };
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function phoneMatches(source: string, incoming: string) {
  const sourceDigits = normalizePhone(source);
  const incomingDigits = normalizePhone(incoming);

  if (!sourceDigits || !incomingDigits) {
    return false;
  }

  return (
    sourceDigits === incomingDigits ||
    sourceDigits.endsWith(incomingDigits) ||
    incomingDigits.endsWith(sourceDigits)
  );
}

async function findActiveUserByPhone(phone: string) {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: {
      id: true,
      companyId: true,
      phone: true,
    },
  });

  return users.find((user) => phoneMatches(user.phone, phone)) ?? null;
}

export async function getBotConfig(account: string | undefined, phone: string) {
  const matchedUser = await findActiveUserByPhone(phone);
  if (!matchedUser) {
    throw new AppError("El numero indicado no pertenece a un usuario activo con acceso a esta configuracion", 403);
  }

  return buildBotConfig(matchedUser.companyId, account);
}

/**
 * Construye el contexto del agente para una empresa ya resuelta. Lo usa tanto
 * getBotConfig (resuelve la empresa por phone admin) como el runtime del agente
 * (resuelve la empresa por la cuenta SMS Tools que recibió el mensaje).
 */
export async function buildBotConfig(companyId: string, account?: string) {
  const whatsappConfig = await prisma.whatsappConfig.findFirst({
    where: {
      companyId,
      isActive: true,
      // El "account" puede ser el unique de SMS Tools o el phone_number_id de
      // Meta (que se guarda en metaPhoneNumberId). Aceptar ambos.
      ...(account ? { OR: [{ account }, { metaPhoneNumberId: account }] } : {}),
    },
    include: { company: true },
  });

  if (!whatsappConfig || !whatsappConfig.company.isActive) {
    if (account) {
      throw new AppError("No existe una configuracion activa para la cuenta de WhatsApp indicada", 404);
    }

    throw new AppError("No existe una configuracion activa de WhatsApp para el usuario indicado", 404);
  }

  const [agentConfig, paymentConfig, products] = await Promise.all([
    prisma.agentConfig.findUnique({ where: { companyId: whatsappConfig.companyId } }),
    prisma.paymentConfig.findUnique({
      where: { companyId: whatsappConfig.companyId },
      include: {
        methods: {
          orderBy: { sortOrder: "asc" },
        },
      },
    }),
    prisma.product.findMany({
      where: {
        companyId: whatsappConfig.companyId,
        active: true,
      },
      include: productRelations,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    }),
  ]);

  if (!agentConfig) {
    throw new AppError("Falta AgentConfig para esta empresa", 422);
  }

  // En modo FLOW (chatbot de flujos guiados) no se usa OpenAI ni el catálogo
  // del agente: no exigimos apiKey ni configuración de entrega por producto.
  // HYBRID (flujo califica → agente continúa) exige lo mismo que AI.
  const botMode = (whatsappConfig.company.botMode as "AI" | "FLOW" | "HYBRID") ?? "AI";

  if (!agentConfig.openaiApiKey && botMode !== "FLOW") {
    throw new AppError("Falta openaiApiKey para esta empresa", 422);
  }

  if (!paymentConfig) {
    throw new AppError("Falta PaymentConfig para esta empresa", 422);
  }

  // Validación de entrega rubro-aware: digitales (infoproducto/streaming) requieren
  // el mensaje de entrega (instructions; el link va dentro); físico requiere entrega
  // por producto; restaurante usa la entrega del negocio (no por plato); servicio no
  // requiere entrega (reserva del agente).
  const vertical = whatsappConfig.company.vertical;
  for (const product of botMode === "FLOW" ? [] : products) {
    if ((vertical === "INFOPRODUCT" || vertical === "STREAMER") && product.productType === "DIGITAL") {
      // El mensaje de entrega (instructions) solo es obligatorio en modo STATIC (mensaje
      // fijo). En POOL_AUTO la entrega usa la credencial del inventario (plantilla opcional)
      // y en MANUAL la entrega la hace un asesor → no requieren instructions. Exigirlo a
      // todos rompía el agente de la empresa cuando había un producto MANUAL/POOL_AUTO.
      const mode = (product.digitalDelivery as { assignmentMode?: string } | null)?.assignmentMode ?? "STATIC";
      if (mode === "STATIC" && !product.digitalDelivery?.instructions?.trim()) {
        throw new AppError(`El producto digital ${product.slug} no tiene mensaje de entrega configurado`, 422);
      }
    }
    if (vertical === "PHYSICAL_GOODS" && product.productType === "PHYSICAL" && !product.physicalDelivery) {
      throw new AppError(`El producto fisico ${product.slug} no tiene physicalDelivery`, 422);
    }
  }

  // Tenant de plataforma (agente de ventas del landing): anexar al prompt los
  // paquetes públicos EN VIVO — precios siempre actualizados sin recompilar.
  let basePrompt = agentConfig.basePrompt;
  try {
    if (await isPlatformSalesCompanyId(companyId)) {
      basePrompt += await getLivePlansPromptSection();
    }
  } catch {
    // Si billing falla, el chat sigue con el prompt lean sin la sección de precios.
  }

  return {
    success: true,
    business: {
      id: whatsappConfig.company.id,
      name: whatsappConfig.company.name,
      adminPhone: whatsappConfig.company.adminPhone,
      vertical: whatsappConfig.company.vertical,
      deliveryConfig: (whatsappConfig.company.deliveryConfig ?? null) as Record<string, unknown> | null,
      timezone: whatsappConfig.company.timezone,
      // Enlace fijo de videollamada por defecto (citas online); lo envía el sistema al confirmar.
      meetingUrl: whatsappConfig.company.meetingUrl ?? null,
      // Moneda del negocio: todo texto de dinero del agente deriva su símbolo de aquí.
      currency: whatsappConfig.company.currency ?? "PEN",
      botMode,
      // Pausa configurable entre mensajes consecutivos del bot (ver delivery.gapMsFor).
      messageGapEnabled: whatsappConfig.company.messageGapEnabled,
      messageGapSeconds: whatsappConfig.company.messageGapSeconds,
    },
    // Ajustes del proveedor de IA del tenant (OpenAI/Anthropic/Gemini): incluye
    // model/apiKey/temperature (shape histórico) + provider/baseUrl/caps/
    // transcriptionApiKey para los call sites multi-proveedor.
    openai: resolveAiSettings(agentConfig),
    whatsapp: {
      provider: whatsappConfig.provider,
      apiUrl: whatsappConfig.apiUrl,
      secret: whatsappConfig.secret,
      account: whatsappConfig.account,
    },
    payment: {
      enabled: paymentConfig.enabled,
      paymentMode: paymentConfig.paymentMode.toLowerCase(),
      methods: paymentConfig.methods.map((item) => ({
        method: item.method,
        number: item.number,
        holder: item.holder,
        sortOrder: item.sortOrder,
      })),
      notification: {
        whatsappPhone: paymentConfig.notificationPhone,
      },
      // Mercado Pago: el token viaja CIFRADO tal como está en BD; se descifra
      // recién al crear la preference (agent-tools) para no exponerlo en logs.
      mp: {
        enabled: paymentConfig.mpEnabled && Boolean(paymentConfig.mpAccessToken),
        accessTokenEnc: paymentConfig.mpAccessToken,
        feeMode: paymentConfig.mpFeeMode,
        feePercent: Number(paymentConfig.mpFeePercent),
        feeFixed: Number(paymentConfig.mpFeeFixed),
        feeIgv: paymentConfig.mpFeeIgv,
        // Canal chat: el link solo se agrega al cobro si está habilitado para el chat.
        chatEnabled: paymentConfig.mpChatEnabled,
      },
    },
    agent: {
      basePrompt,
      salesStyle: agentConfig.salesStyle,
      rules: agentConfig.rules as string[],
      followupConfig: agentConfig.followupConfig ?? null,
      replyMode: (agentConfig.replyMode as string) ?? "OPEN",
      testNumbers: Array.isArray(agentConfig.testNumbers)
        ? (agentConfig.testNumbers as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      mutedNumbers: Array.isArray(agentConfig.mutedNumbers)
        ? (agentConfig.mutedNumbers as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      muteAfterSale: agentConfig.muteAfterSale ?? true,
      negotiationHandoff: agentConfig.negotiationHandoff ?? false,
      // Compat: antes el toggle del panel guardaba una frase en `rules`; si sigue
      // ahí, el negocio lo tenía activado → se respeta sin obligar a re-guardar.
      unknownHandoff:
        (agentConfig.unknownHandoff ?? false) ||
        (Array.isArray(agentConfig.rules) && (agentConfig.rules as unknown[]).includes(LEGACY_UNKNOWN_HANDOFF_RULE)),
      humanChatAlerts: agentConfig.humanChatAlerts ?? true,
      // Rubro Comercial: comportamiento configurable del agente.
      catalogMode: (agentConfig.catalogMode as string) ?? "preguntar",
      keywordMode: (agentConfig.keywordMode as string) ?? "detalle_y_preguntar",
      trackStock: agentConfig.trackStock ?? true,
      // Presentación del catálogo (texto / carta multimedia / ambos).
      catalogMediaMode: (agentConfig.catalogMediaMode as string) ?? "text",
      catalogMediaUrl: agentConfig.catalogMediaUrl ?? null,
      catalogMediaType: agentConfig.catalogMediaType ?? null,
      catalogMediaFileName: agentConfig.catalogMediaFileName ?? null,
      // Herramienta de CRM del agente (null = apagada: cero consultas extra).
      crmTool: await resolveAgentCrmTool(whatsappConfig.companyId, agentConfig.crmToolConfig),
      promptPreview: `${agentConfig.basePrompt}\n\nEstilo comercial: ${agentConfig.salesStyle}\nTemperatura: ${Number(agentConfig.temperature)}\nReglas:\n${Array.isArray(agentConfig.rules) ? agentConfig.rules.map((rule, index) => `${index + 1}. ${String(rule)}`).join("\n") : ""}`,
    },
    products: products.map((p) =>
      withVariantModifiers(
        mapBotProduct(p, {
          timezone: whatsappConfig.company.timezone,
          currencySymbol: symbolFor(whatsappConfig.company.currency),
        }),
      ),
    ),
  };
}

/**
 * Variantes seleccionables en el carrito: para productos físicos con variantes
 * (talla/color), derivar modifierGroups sintéticos (priceDelta 0) que el carrito
 * ya sabe resolver, sin pisar modifierGroups reales (restaurante).
 */
function withVariantModifiers(p: ReturnType<typeof mapBotProduct>): ReturnType<typeof mapBotProduct> {
  if (p.productType !== "PHYSICAL" || !Array.isArray(p.variants) || !p.variants.length) return p;
  const vd = (p.verticalData ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(vd.modifierGroups) ? (vd.modifierGroups as unknown[]) : [];
  const groups = (p.variants as Array<{ name: string; options: string[] }>).map((v) => ({
    name: v.name,
    required: true,
    options: (v.options ?? []).map((o) => ({ label: o, priceDelta: 0 })),
  }));
  return { ...p, verticalData: { ...vd, modifierGroups: [...existing, ...groups] } };
}
