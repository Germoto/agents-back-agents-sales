/**
 * Tienda web pública por tenant (<slug>.<STORE_DOMAIN> o /tienda/<slug>).
 *
 * MVP infoproductos: catálogo del tenant (solo digitales con entrega por correo),
 * checkout de UN producto con Mercado Pago y entrega automática por correo
 * (+ WhatsApp si el comprador dejó su número). Reutiliza: mpCreatePreference,
 * webhook MP (rama storeOrderId), sendDigitalDeliveryEmail,
 * handleExternalPaymentApproved, gateNewLead/getEntitlements.
 *
 * Nada de esto toca el flujo del agente: módulo aparte, tablas nuevas.
 */

import crypto from "crypto";
import { Prisma, type StoreOrderStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { decryptCredential } from "../../lib/credentials-crypto";
import { mpCreatePreference, mpLinkAmount, type MpPayment } from "../../lib/mercadopago-client";
import { mapBotProduct, productRelations } from "../../lib/product";
import { symbolFor } from "../../lib/currency";
import { normalizeEmail } from "../../lib/email";
import { isValidStoreSlug, storeSlugProblem } from "../../lib/slug";
import { getEntitlements } from "../billing/entitlements";
import { gateNewLead } from "../billing/billing.service";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { normalizePhone, loadOrCreateConversation, notifyOwner } from "../agent/conversation.service";
import { sendDigitalDeliveryEmail, EmailDeliveryError } from "../agent/email-delivery";
import { handleExternalPaymentApproved } from "../agent/agent.service";
import { loadWhatsappSender } from "../agent/outbound";

// ---------------------------------------------------------------------------
// URL y resolución
// ---------------------------------------------------------------------------

/** URL pública de la tienda de un slug (subdominio en prod; path en desarrollo). */
export function storeUrl(slug: string): string {
  if (env.STORE_DOMAIN) return `https://${slug}.${env.STORE_DOMAIN}`;
  const base = (env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  return `${base}/tienda/${slug}`;
}

type StoreCompany = {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  isActive: boolean;
};

/** Empresa + config de tienda por slug. Lanza 404 si no existe o no está activa. */
async function resolveStore(slug: string) {
  const s = slug.trim().toLowerCase();
  if (!isValidStoreSlug(s)) throw new AppError("Tienda no encontrada", 404);
  const company = await prisma.company.findUnique({
    where: { slug: s },
    select: { id: true, name: true, slug: true, currency: true, timezone: true, isActive: true },
  });
  if (!company || !company.isActive) throw new AppError("Tienda no encontrada", 404);
  const cfg = await prisma.storefrontConfig.findUnique({ where: { companyId: company.id } });
  if (!cfg || !cfg.enabled) throw new AppError("Tienda no encontrada", 404);
  const ent = await getEntitlements(company.id);
  if (ent.blocked || !(ent.legacy || ent.modules.includes("STOREFRONT"))) {
    throw new AppError("Tienda no disponible", 404);
  }
  return { company: company as StoreCompany, cfg, ent };
}

/**
 * Hosts fijos de la plataforma bajo el dominio base. Con un site `*.<dominio>`
 * en on_demand, Caddy agrupa bajo esa política a los subdominios sin opciones
 * `tls` propias (api, www) y consulta el `ask` también para ellos: si se
 * rechazan, su TLS se cae. Siempre se aprueban.
 */
const PLATFORM_HOSTS = new Set(["api", "www", "app"]);

/** Caddy on_demand_tls `ask`: 200 si el host es una tienda activa o un host fijo de la plataforma. Cache 60 s. */
const tlsAskCache = new Map<string, { ok: boolean; ts: number }>();
export async function tlsAsk(domain: string): Promise<boolean> {
  const host = domain.trim().toLowerCase();
  if (!env.STORE_DOMAIN) return false;
  if (host === env.STORE_DOMAIN) return true;
  if (!host.endsWith(`.${env.STORE_DOMAIN}`)) return false;
  const slug = host.slice(0, -(env.STORE_DOMAIN.length + 1));
  if (PLATFORM_HOSTS.has(slug)) return true;
  if (!isValidStoreSlug(slug)) return false;
  const hit = tlsAskCache.get(host);
  if (hit && Date.now() - hit.ts < 60_000) return hit.ok;
  let ok = false;
  try {
    await resolveStore(slug);
    ok = true;
  } catch {
    ok = false;
  }
  tlsAskCache.set(host, { ok, ts: Date.now() });
  return ok;
}

// ---------------------------------------------------------------------------
// Catálogo público
// ---------------------------------------------------------------------------

/** Productos elegibles: digitales, activos, en catálogo, entrega fija y con correo. */
async function eligibleProducts(companyId: string, productIds: string[]) {
  const rows = await prisma.product.findMany({
    where: {
      companyId,
      active: true,
      showInCatalog: true,
      productType: "DIGITAL",
      ...(productIds.length ? { id: { in: productIds } } : {}),
      digitalDelivery: { is: { assignmentMode: "STATIC", emailEnabled: true } },
    },
    include: productRelations,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows;
}

export async function getPublicStore(slug: string) {
  const { company, cfg } = await resolveStore(slug);
  const symbol = symbolFor(company.currency);
  const products = await eligibleProducts(company.id, cfg.productIds);
  return {
    negocio: {
      slug: company.slug,
      name: company.name,
      title: cfg.title || company.name,
      tagline: cfg.tagline || null,
      accentColor: cfg.accentColor || null,
      logoUrl: cfg.logoUrl || null,
      currency: company.currency,
      whatsappNumber: cfg.whatsappNumber ? cfg.whatsappNumber.replace(/\D/g, "") || null : null,
    },
    productos: products.map((p) => {
      const b = mapBotProduct(p, { currencySymbol: symbol, timezone: company.timezone });
      return {
        id: b.id,
        slug: b.slug,
        name: b.name,
        price: b.price,
        priceText: b.priceText,
        regularPriceText: b.regularPriceText,
        offerActive: b.offerActive,
        offerEndsText: b.offerEndsText,
        shortDescription: b.shortDescription,
        fullDescription: b.fullDescription,
        category: b.category,
        benefits: b.benefits,
        includes: b.includes,
        bonuses: b.bonuses,
        faqs: b.faqs.map((f) => ({ question: f.question, answer: f.answer })),
        // Solo imágenes de presentación (nunca los archivos de entrega).
        images: p.files
          .filter((f) => f.type === "IMAGE" && f.showInPresentation)
          .map((f) => ({ url: f.url, description: f.description || "" })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Checkout (Mercado Pago)
// ---------------------------------------------------------------------------

function parsePrice(v: string | null | undefined): number {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Teléfono sintético estable por comprador sin WhatsApp (ignorado por scheduler/campañas). */
function syntheticPhone(email: string): string {
  return `web:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 12)}`;
}

export async function createStoreCheckout(
  slug: string,
  input: { productId: string; name: string; email: string; phone?: string | null },
) {
  const { company, cfg, ent } = await resolveStore(slug);
  const companyId = company.id;

  const email = normalizeEmail(input.email);
  if (!email) throw new AppError("El correo no es válido", 400);
  const name = input.name.trim();
  const digits = (input.phone ?? "").replace(/\D/g, "");
  if (digits && digits.length < 8) throw new AppError("El número de WhatsApp no es válido", 400);

  if (!(ent.legacy || ent.modules.includes("MERCADOPAGO"))) {
    throw new AppError("Esta tienda aún no tiene pagos habilitados", 409);
  }
  const pc = await prisma.paymentConfig.findUnique({ where: { companyId } });
  if (!pc?.mpEnabled || !pc.mpAccessToken || !pc.mpStoreEnabled) {
    throw new AppError("Esta tienda aún no tiene pagos habilitados", 409);
  }

  const [product] = await eligibleProducts(companyId, cfg.productIds).then((rows) =>
    rows.filter((p) => p.id === input.productId),
  );
  if (!product) throw new AppError("Producto no disponible", 404);
  const bot = mapBotProduct(product, { currencySymbol: symbolFor(company.currency), timezone: company.timezone });
  const priceNum = parsePrice(bot.price);
  if (priceNum <= 0) throw new AppError("Este producto no tiene un precio válido para compra online", 409);
  const linkAmount = mpLinkAmount(priceNum, {
    feeMode: pc.mpFeeMode,
    feePercent: Number(pc.mpFeePercent),
    feeFixed: Number(pc.mpFeeFixed),
    feeIgv: pc.mpFeeIgv,
  });

  // Cliente: WhatsApp real si lo dio; si no, teléfono sintético estable por email.
  const phone = digits ? normalizePhone(digits) : syntheticPhone(email);
  const existing = await prisma.customer.findUnique({
    where: { companyId_phone: { companyId, phone } },
    select: { id: true, name: true, email: true },
  });
  if (!ent.legacy && !existing) {
    const allowed = await gateNewLead(companyId, phone);
    if (!allowed) throw new AppError("La tienda no puede recibir compras por el momento", 503);
  }
  const customer = await prisma.customer.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: {
      lastInteractionAt: new Date(),
      email,
      ...(existing?.name ? {} : { name }),
    },
    create: {
      companyId,
      phone,
      name,
      email,
      status: "activo",
      lastInteractionAt: new Date(),
      metadata: { origin: "storefront" },
    },
    select: { id: true },
  });

  const accessToken = crypto.randomBytes(18).toString("base64url");
  const order = await prisma.storeOrder.create({
    data: {
      companyId,
      customerId: customer.id,
      productId: product.id,
      productName: product.name,
      email,
      name,
      phone: digits ? phone : null,
      amount: new Prisma.Decimal(linkAmount.toFixed(2)),
      currency: company.currency,
      accessToken,
      metadata: { listPrice: priceNum, feeMode: pc.mpFeeMode },
    },
  });

  const base = storeUrl(company.slug);
  const thanks = `${base}/gracias?o=${order.id}&t=${accessToken}`;
  const https = base.startsWith("https://");
  let pref;
  try {
    pref = await mpCreatePreference(decryptCredential(pc.mpAccessToken), {
      title: product.name,
      amount: linkAmount,
      currency: company.currency.toUpperCase(),
      externalReference: JSON.stringify({ storeOrderId: order.id }),
      notificationUrl: `${env.PUBLIC_BASE_URL}/api/webhooks/mercadopago/${companyId}`,
      backUrls: { success: thanks, failure: `${thanks}&r=failure`, pending: `${thanks}&r=pending` },
      autoReturn: https,
    });
  } catch (err) {
    await prisma.storeOrder.update({
      where: { id: order.id },
      data: { status: "FALLIDO", failureReason: `Mercado Pago: ${err instanceof Error ? err.message : "error"}` },
    });
    console.error(`[storefront] MP preference falló company=${companyId}:`, err instanceof Error ? err.message : err);
    throw new AppError("No se pudo iniciar el pago. Intenta de nuevo en un momento.", 502);
  }
  await prisma.storeOrder.update({ where: { id: order.id }, data: { mpPreferenceId: pref.id } });

  return {
    orderId: order.id,
    token: accessToken,
    initPoint: pref.init_point,
    amount: linkAmount,
    amountText: `${symbolFor(company.currency)} ${linkAmount.toFixed(2)}`,
    feeIncluded: linkAmount > priceNum,
  };
}

// ---------------------------------------------------------------------------
// Estado del pedido (página de gracias)
// ---------------------------------------------------------------------------

export async function getPublicOrder(id: string, token: string) {
  const order = await prisma.storeOrder.findUnique({ where: { id } });
  if (!order || order.accessToken !== token) throw new AppError("Pedido no encontrado", 404);
  const mensaje: Record<StoreOrderStatus, string> = {
    PENDIENTE: "Esperando la confirmación del pago…",
    PAGADO: "Pago confirmado. Preparando tu acceso…",
    ENTREGADO: `Listo: te enviamos el acceso a ${order.email}. Si no lo ves, revisa spam o promociones.`,
    FALLIDO: "Hubo un inconveniente con tu pedido. Escríbenos y lo resolvemos.",
  };
  return {
    id: order.id,
    status: order.status,
    productName: order.productName,
    email: order.email,
    deliveredAt: order.deliveredAt,
    mensaje: mensaje[order.status],
  };
}

// ---------------------------------------------------------------------------
// Webhook de Mercado Pago → pedido web pagado → entrega
// ---------------------------------------------------------------------------

/**
 * Rama "pedido web" del webhook MP. Idempotente: si el pedido ya está PAGADO/
 * ENTREGADO o el receipt (source, externalId) ya existe, no hace nada.
 */
export async function fulfillStoreOrderFromMp(companyId: string, storeOrderId: string, payment: MpPayment) {
  const order = await prisma.storeOrder.findFirst({ where: { id: storeOrderId, companyId } });
  if (!order) return { ok: true, ignored: true as const };
  if (order.status === "PAGADO" || order.status === "ENTREGADO") return { ok: true, duplicate: true as const };

  const paid = Number(payment.transaction_amount ?? 0);
  const expected = Number(order.amount);
  const externalId = String(payment.id);
  const payerName =
    [payment.payer?.first_name, payment.payer?.last_name].filter(Boolean).join(" ").trim() || order.name;

  if (paid + 0.01 < expected) {
    await prisma.storeOrder.update({
      where: { id: order.id },
      data: { status: "FALLIDO", mpPaymentId: externalId, failureReason: `Monto pagado ${paid} menor al pedido ${expected}` },
    });
    void notifyOwner(
      companyId,
      `⚠️ Pago de tu tienda web por un monto menor al pedido (${paid} vs ${expected}) — ${order.productName} · ${order.email}. No se entregó.`,
    ).catch(() => undefined);
    return { ok: true, ignored: true as const };
  }

  let receiptId: string;
  try {
    const receipt = await prisma.paymentReceipt.create({
      data: {
        companyId,
        customerId: order.customerId,
        productId: order.productId,
        productIds: [order.productId],
        amountExpected: String(paid),
        amountPaid: String(paid),
        currency: payment.currency_id ?? order.currency,
        status: "APROBADO",
        source: "mercadopago",
        externalId,
        payerName,
        paymentSource: "mercadopago",
        occurredAt: payment.date_approved ? new Date(payment.date_approved) : new Date(),
        validatedAt: new Date(),
        validationMode: "AUTO",
        validationNote: "Compra en la tienda web confirmada por Mercado Pago (webhook + verificación API)",
        metadata: { channel: "storefront", storeOrderId: order.id, mpPaymentId: externalId, email: order.email },
      },
    });
    receiptId = receipt.id;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return { ok: true, duplicate: true as const };
    throw err;
  }

  await prisma.storeOrder.update({
    where: { id: order.id },
    data: { status: "PAGADO", receiptId, mpPaymentId: externalId },
  });
  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_NEW, { receiptId, source: "mercadopago" });

  const amountText = `${symbolFor(order.currency)} ${paid.toFixed(2)}`;

  // Entrega por correo (requisito del MVP) + WhatsApp si dejó número real.
  let emailOk = false;
  let failure: string | null = null;
  try {
    await sendDigitalDeliveryEmail({ companyId, customerId: order.customerId, receiptId, email: order.email, trigger: "web" });
    emailOk = true;
  } catch (err) {
    failure = err instanceof EmailDeliveryError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : "error";
    console.error(`[storefront] entrega por correo falló order=${order.id}: ${failure}`);
  }

  let waDelivered = false;
  if (order.phone && !order.phone.startsWith("web:")) {
    try {
      const sender = await loadWhatsappSender(companyId);
      if (sender) {
        const convo = await loadOrCreateConversation(companyId, order.phone, null);
        await handleExternalPaymentApproved({
          companyId,
          conversationId: convo.conversationId,
          productIds: [order.productId],
          amountText,
          payerName,
          provider: "Mercado Pago (tienda web)",
        });
        waDelivered = true;
      }
    } catch (err) {
      console.warn(`[storefront] entrega por WhatsApp falló order=${order.id}:`, err instanceof Error ? err.message : err);
    }
  }

  const delivered = emailOk || waDelivered;
  await prisma.storeOrder.update({
    where: { id: order.id },
    data: delivered
      ? { status: "ENTREGADO", deliveredAt: new Date(), failureReason: failure, metadata: { ...(order.metadata as object ?? {}), emailOk, waDelivered } }
      : { status: "FALLIDO", failureReason: failure ?? "sin canal de entrega" },
  });

  // Aviso al dueño (handleExternalPaymentApproved ya avisa cuando hubo WhatsApp).
  if (!waDelivered) {
    void notifyOwner(
      companyId,
      delivered
        ? `🛒 Venta en tu tienda web: *${order.productName}* · ${amountText} · ${order.email}. Acceso enviado por correo ✅`
        : `⚠️ Venta en tu tienda web (${order.productName} · ${amountText} · ${order.email}) PAGADA pero no se pudo entregar: ${failure}. Reenvía el acceso desde la ficha del cliente.`,
    ).catch(() => undefined);
  }
  console.log(`[storefront] pedido ${order.id} ${delivered ? "ENTREGADO" : "FALLIDO"} email=${emailOk} wa=${waDelivered}`);
  return { ok: true, receiptId };
}

// ---------------------------------------------------------------------------
// Panel del tenant
// ---------------------------------------------------------------------------

export async function getStorefrontConfig(companyId: string) {
  const cfg =
    (await prisma.storefrontConfig.findUnique({ where: { companyId } })) ??
    (await prisma.storefrontConfig.create({ data: { companyId } }));
  return { ...cfg, status: await storefrontStatus(companyId, cfg.enabled) };
}

export async function updateStorefrontConfig(
  companyId: string,
  data: {
    enabled?: boolean;
    title?: string | null;
    tagline?: string | null;
    accentColor?: string | null;
    logoUrl?: string | null;
    whatsappNumber?: string | null;
    productIds?: string[];
  },
) {
  if (data.logoUrl) {
    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
    if (!data.logoUrl.startsWith(`${base}/uploads/`)) throw new AppError("El logo debe ser un archivo subido a FlowApp", 400);
  }
  if (data.enabled === true) {
    const st = await storefrontStatus(companyId, true);
    if (!st.slugValido) throw new AppError(`No se puede activar: ${st.slugProblema}`, 409);
  }
  const cfg = await prisma.storefrontConfig.upsert({
    where: { companyId },
    update: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.title !== undefined ? { title: data.title?.trim() || null } : {}),
      ...(data.tagline !== undefined ? { tagline: data.tagline?.trim() || null } : {}),
      ...(data.accentColor !== undefined ? { accentColor: data.accentColor || null } : {}),
      ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl || null } : {}),
      ...(data.whatsappNumber !== undefined ? { whatsappNumber: data.whatsappNumber?.replace(/\D/g, "") || null } : {}),
      ...(data.productIds !== undefined ? { productIds: data.productIds } : {}),
    },
    create: {
      companyId,
      enabled: data.enabled ?? false,
      title: data.title?.trim() || null,
      tagline: data.tagline?.trim() || null,
      accentColor: data.accentColor || null,
      logoUrl: data.logoUrl || null,
      whatsappNumber: data.whatsappNumber?.replace(/\D/g, "") || null,
      productIds: data.productIds ?? [],
    },
  });
  tlsAskCache.clear();
  return { ...cfg, status: await storefrontStatus(companyId, cfg.enabled) };
}

/** Checklist de requisitos de la tienda (para el panel y el copiloto). */
export async function storefrontStatus(companyId: string, enabled: boolean) {
  const [company, pc, ent, cfg] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { slug: true } }),
    prisma.paymentConfig.findUnique({ where: { companyId }, select: { mpEnabled: true, mpAccessToken: true, mpStoreEnabled: true } }),
    getEntitlements(companyId),
    prisma.storefrontConfig.findUnique({ where: { companyId }, select: { productIds: true } }),
  ]);
  const slug = company?.slug ?? "";
  const slugProblema = storeSlugProblem(slug);
  const eligible = await eligibleProducts(companyId, cfg?.productIds ?? []);
  const sinCorreo = await prisma.product.findMany({
    where: {
      companyId,
      active: true,
      showInCatalog: true,
      productType: "DIGITAL",
      OR: [{ digitalDelivery: null }, { digitalDelivery: { is: { OR: [{ emailEnabled: false }, { assignmentMode: { not: "STATIC" } }] } } }],
    },
    select: { id: true, name: true },
  });
  const moduloTienda = ent.legacy || ent.modules.includes("STOREFRONT");
  const moduloMp = ent.legacy || ent.modules.includes("MERCADOPAGO");
  const mpConectado = Boolean(pc?.mpEnabled && pc.mpAccessToken);
  const mpTiendaHabilitado = Boolean(pc?.mpStoreEnabled ?? true);
  const mpConfigurado = mpConectado && mpTiendaHabilitado;
  return {
    url: slugProblema ? null : storeUrl(slug),
    slug,
    slugValido: !slugProblema,
    slugProblema,
    subdominios: Boolean(env.STORE_DOMAIN),
    moduloTienda,
    moduloMp,
    mpConfigurado,
    mpConectado,
    mpTiendaHabilitado,
    productosElegibles: eligible.map((p) => ({ id: p.id, name: p.name })),
    productosSinCorreo: sinCorreo,
    lista: enabled && !slugProblema && moduloTienda && moduloMp && mpConfigurado && eligible.length > 0,
  };
}

export async function listStoreOrders(companyId: string, page = 1, limit = 25) {
  const [items, total] = await Promise.all([
    prisma.storeOrder.findMany({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        productId: true,
        productName: true,
        name: true,
        email: true,
        phone: true,
        amount: true,
        currency: true,
        status: true,
        receiptId: true,
        deliveredAt: true,
        failureReason: true,
        createdAt: true,
        customerId: true,
      },
    }),
    prisma.storeOrder.count({ where: { companyId } }),
  ]);
  return {
    items: items.map((o) => ({ ...o, amount: Number(o.amount), amountText: `${symbolFor(o.currency)} ${Number(o.amount).toFixed(2)}` })),
    total,
    page,
    limit,
  };
}
