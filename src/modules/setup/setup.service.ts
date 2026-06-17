import { prisma } from "../../lib/prisma";

/**
 * Estado de activación del tenant (onboarding). Deriva el progreso de los datos
 * existentes — NO hay tabla propia. El frontend renderiza `steps` tal cual, así
 * que toda la lógica de "qué falta para quedar operativo" vive acá y ramifica por
 * `botMode` (AI = agente abierto; FLOW = chatbot de flujos).
 */

type SetupStepKind = "step" | "action";

export interface SetupStep {
  key: string;
  title: string;
  description: string;
  done: boolean;
  required: boolean;
  kind: SetupStepKind;
  highlight?: boolean;
  ctaLabel: string;
  ctaPath: string;
  icon: string;
}

export interface SetupStatus {
  complete: boolean;
  percent: number;
  botMode: "AI" | "FLOW";
  steps: SetupStep[];
}

export async function getSetupStatus(companyId: string): Promise<SetupStatus> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { botMode: true },
  });

  const botMode: "AI" | "FLOW" = company?.botMode === "FLOW" ? "FLOW" : "AI";

  const [productCount, agentConfig, whatsapp, payment, activeFlows, conversationCount] =
    await Promise.all([
      prisma.product.count({ where: { companyId, active: true } }),
      prisma.agentConfig.findUnique({
        where: { companyId },
        select: { openaiApiKey: true, basePrompt: true },
      }),
      prisma.whatsappConfig.findUnique({
        where: { companyId },
        select: { account: true, secret: true, isActive: true },
      }),
      prisma.paymentConfig.findUnique({
        where: { companyId },
        select: { enabled: true, _count: { select: { methods: true } } },
      }),
      prisma.chatFlow.count({ where: { companyId, isActive: true } }),
      prisma.conversation.count({ where: { companyId } }),
    ]);

  const steps: SetupStep[] = [];

  // 1. Cuenta creada — siempre hecha (ancla el % base).
  steps.push({
    key: "account",
    title: "Cuenta creada",
    description: "Tu empresa ya está dada de alta en la plataforma.",
    done: true,
    required: true,
    kind: "step",
    ctaLabel: "Ver empresa",
    ctaPath: "/empresa",
    icon: "company",
  });

  // 2. Producto en el catálogo.
  steps.push({
    key: "products",
    title: "Agrega tu primer producto",
    description: "Carga al menos un producto para que tu agente sepa qué vender.",
    done: productCount > 0,
    required: true,
    kind: "step",
    ctaLabel: "Ir a Productos",
    ctaPath: "/productos",
    icon: "box",
  });

  // 3. Configurar el cerebro del bot — ramifica por modo.
  if (botMode === "FLOW") {
    steps.push({
      key: "flow",
      title: "Crea y activa tu flujo de chatbot",
      description: "Diseña el flujo guiado que responderá a tus clientes y actívalo.",
      done: activeFlows > 0,
      required: true,
      kind: "step",
      ctaLabel: "Ir a Flujos",
      ctaPath: "/flujos",
      icon: "flow",
    });
  } else {
    const agentDone = !!agentConfig?.openaiApiKey && !!agentConfig?.basePrompt?.trim();
    steps.push({
      key: "agent",
      title: "Configura tu agente IA",
      description: "Agrega tu API key de OpenAI y define cómo debe vender tu agente.",
      done: agentDone,
      required: true,
      kind: "step",
      ctaLabel: "Ir a Agente IA",
      ctaPath: "/agente",
      icon: "bot",
    });
  }

  // 4. Métodos de pago.
  const paymentsDone = !!payment?.enabled && (payment?._count.methods ?? 0) > 0;
  steps.push({
    key: "payments",
    title: "Configura tus métodos de pago",
    description: "Define cómo te van a pagar tus clientes (Yape, Plin, transferencia…).",
    done: paymentsDone,
    required: true,
    kind: "step",
    ctaLabel: "Ir a Pagos",
    ctaPath: "/pagos",
    icon: "card",
  });

  // 5. Conectar WhatsApp — paso clave.
  const whatsappDone = !!whatsapp?.account && !!whatsapp?.secret && !!whatsapp?.isActive;
  steps.push({
    key: "whatsapp",
    title: "Conecta tu WhatsApp",
    description: "Vincula tu número para que tu agente empiece a responder 24/7.",
    done: whatsappDone,
    required: true,
    kind: "step",
    highlight: true,
    ctaLabel: "Conectar WhatsApp",
    ctaPath: "/whatsapp",
    icon: "whatsapp",
  });

  // 6. Extras (no cuentan al %).
  steps.push({
    key: "test",
    title: "Prueba tu agente",
    description: "Ensaya cómo responde tu agente antes de atender clientes reales.",
    done: conversationCount > 0,
    required: false,
    kind: "step",
    ctaLabel: "Ir a Pruebas",
    ctaPath: "/pruebas",
    icon: "play",
  });

  steps.push({
    key: "training",
    title: "Capacitación 1:1 gratuita",
    description: "Te acompañamos para que aproveches al máximo tu asistente.",
    done: false,
    required: false,
    kind: "action",
    ctaLabel: "Quiero capacitación",
    ctaPath: "",
    icon: "help",
  });

  const required = steps.filter((s) => s.required);
  const doneRequired = required.filter((s) => s.done).length;
  const percent = required.length === 0
    ? 100
    : Math.round((doneRequired / required.length) * 100);

  return {
    complete: percent === 100,
    percent,
    botMode,
    steps,
  };
}
