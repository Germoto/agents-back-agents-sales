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

const MAX_ITERATIONS = 8;
const HISTORY_LIMIT = 16;

interface CopilotBody {
  messages: Array<{ role: "user" | "assistant"; content: string; imageUrls?: string[] }>;
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
];

// ---------------------------------------------------------------------------
// Guía de campos por rubro (espejo compacto de los blueprints del panel)
// ---------------------------------------------------------------------------
const COMMON_FIELDS =
  "Campos comunes de `data`: name*, price* (texto, ej. '12' o '12.50'), shortDescription (1 línea vendedora), fullDescription, category, active (default true), aliases (string[] — sinónimos/abreviaturas con las que el cliente lo nombraría), benefits (string[]), includes (string[]), bonuses (string[]), faqs ([{question, answer}]), objections ([{question, answer}]), attributes (objeto clave→valor, ej. {\"Ingredientes\": \"pollo, papas\"}).";

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
      return `Rubro STREAMING (cada producto = una plataforma/cuenta). ${COMMON_FIELDS} Además: category = plataforma (Netflix, Disney...); verticalData.plans = [{label, price}] para modalidades (mensual/anual, pantallas); digitalDelivery = {instructions (mensaje de entrega con el acceso), assignmentMode}.`;
    case "INFOPRODUCT":
      return `Rubro INFOPRODUCTOS (cursos, ebooks, accesos). ${COMMON_FIELDS} Además: digitalDelivery = {instructions* (mensaje de entrega que incluye el link de acceso), link}; benefits/faqs/objections completos son CLAVE para que el agente venda bien.`;
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
    reminderConfig: (e?.reminderConfig ?? null) as Record<string, unknown> | null,
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
async function runCopilotTool(
  companyId: string,
  name: string,
  args: LooseData,
): Promise<{ result: string; wrote: boolean }> {
  switch (name) {
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
    "- FLUJO OBLIGATORIO para escribir: primero entiende lo que quiere, luego PROPONLE un resumen claro (lista de productos con nombre/precio/detalles) y espera su CONFIRMACIÓN ('sí', 'dale', 'confirmo'). SOLO entonces llama crear_producto/actualizar_producto (una llamada por producto). NUNCA escribas sin confirmación previa en esta conversación.",
    "- Si el usuario envía una FOTO (carta, lista de precios, catálogo), LÉELA con cuidado: extrae nombres, precios, secciones y descripciones, y propón los productos completos (con aliases y 1-2 FAQs razonables por producto cuando ayuden a vender). No inventes lo que no se ve — pregunta lo que falte.",
    "- actualizar_producto es PARCIAL: envía solo los campos a cambiar; el resto se conserva solo.",
    "- eliminar_producto: SOLO si lo pidió explícitamente y confirmó el nombre. Nunca elimines por iniciativa propia.",
    "- No gestionas datos sensibles (API keys, tokens de pago, WhatsApp): para eso indícale la página del panel correspondiente.",
    "- Tras crear/modificar, resume QUÉ quedó hecho y sugiere el siguiente paso (revisar en Productos, probar en el simulador, configurar pagos...).",
    "- Respuestas cortas y claras. Una pregunta a la vez. Los precios/datos que devuelven las herramientas son la fuente de verdad.",
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
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map((m): ChatMessage => {
      if (m.role === "user" && m.imageUrls?.length) {
        const parts: ContentPart[] = [
          { type: "text", text: m.content },
          ...m.imageUrls.map((url): ContentPart => ({ type: "image_url", image_url: { url } })),
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
        const { result, wrote } = await runCopilotTool(companyId, call.function.name, parsedArgs);
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
