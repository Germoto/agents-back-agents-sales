import { AppError } from "../../lib/app-error";
import { prisma } from "../../lib/prisma";
import { mapBotProduct, productRelations } from "../../lib/product";

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
      ...(account ? { account } : {}),
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
  const botMode = (whatsappConfig.company.botMode as "AI" | "FLOW") ?? "AI";

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

  return {
    success: true,
    business: {
      id: whatsappConfig.company.id,
      name: whatsappConfig.company.name,
      adminPhone: whatsappConfig.company.adminPhone,
      vertical: whatsappConfig.company.vertical,
      deliveryConfig: (whatsappConfig.company.deliveryConfig ?? null) as Record<string, unknown> | null,
      timezone: whatsappConfig.company.timezone,
      botMode,
    },
    openai: {
      model: agentConfig.openaiModel,
      apiKey: agentConfig.openaiApiKey,
      temperature: Number(agentConfig.temperature),
    },
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
    },
    agent: {
      basePrompt: agentConfig.basePrompt,
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
      promptPreview: `${agentConfig.basePrompt}\n\nEstilo comercial: ${agentConfig.salesStyle}\nTemperatura: ${Number(agentConfig.temperature)}\nReglas:\n${Array.isArray(agentConfig.rules) ? agentConfig.rules.map((rule, index) => `${index + 1}. ${String(rule)}`).join("\n") : ""}`,
    },
    products: products.map((p) => mapBotProduct(p)),
  };
}
