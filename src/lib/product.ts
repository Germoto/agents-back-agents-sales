import { Prisma } from "@prisma/client";

const productArgs = Prisma.validator<Prisma.ProductDefaultArgs>()({
  include: {
    aliases: true,
    benefits: { orderBy: { sortOrder: "asc" } },
    includes: { orderBy: { sortOrder: "asc" } },
    bonuses: { orderBy: { sortOrder: "asc" } },
    faqs: { orderBy: { sortOrder: "asc" } },
    objections: { orderBy: { sortOrder: "asc" } },
    files: { orderBy: { sortOrder: "asc" } },
    digitalDelivery: true,
    physicalDelivery: true,
    variants: { orderBy: { sortOrder: "asc" } },
  },
});

export const productRelations = productArgs.include;

export type ProductWithRelations = Prisma.ProductGetPayload<{
  include: typeof productRelations;
}>;

function jsonArrayToStrings(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

export interface FollowupMessage {
  message: string;
  mediaUrl: string;
  mediaType: string;
}

/**
 * Normaliza un JSON arbitrario a un array de {message,mediaUrl,mediaType}.
 * Descarta entradas sin texto ni media. Reutilizable para los followups de entrega
 * (DigitalDelivery.followupMessages) y los de presentación (Product.presentationFollowups).
 */
export function normalizeFollowupList(raw: Prisma.JsonValue | null | undefined): FollowupMessage[] {
  const out: FollowupMessage[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = item as Record<string, unknown>;
      const message = typeof o.message === "string" ? o.message : "";
      const mediaUrl = typeof o.mediaUrl === "string" ? o.mediaUrl : "";
      const mediaType = typeof o.mediaType === "string" ? o.mediaType : "";
      if (message.trim() || mediaUrl.trim()) out.push({ message, mediaUrl, mediaType });
    }
  }
  return out;
}

/**
 * Normaliza los mensajes adicionales de entrega a un array de {message,mediaUrl,mediaType}.
 * Lee el JSON `followupMessages`; si está vacío pero hay un single legacy (fila no
 * migrada), sintetiza un elemento.
 */
function normalizeFollowups(dd: ProductWithRelations["digitalDelivery"]): FollowupMessage[] {
  const out = normalizeFollowupList(dd?.followupMessages);
  if (!out.length && dd && (dd.followupMessage?.trim() || dd.followupMediaUrl?.trim())) {
    out.push({
      message: dd.followupMessage ?? "",
      mediaUrl: dd.followupMediaUrl ?? "",
      mediaType: dd.followupMediaType ?? "",
    });
  }
  return out;
}

/** Oferta con vigencia: activa si offerPrice tiene dígitos y now ∈ [startsAt, endsAt] (fechas opcionales = sin límite). */
export function offerIsActive(
  p: { offerPrice?: string | null; offerStartsAt?: Date | null; offerEndsAt?: Date | null },
  now = new Date(),
): boolean {
  const price = p.offerPrice?.trim();
  if (!price || !/\d/.test(price)) return false;
  if (p.offerStartsAt && now < p.offerStartsAt) return false;
  if (p.offerEndsAt && now > p.offerEndsAt) return false;
  return true;
}

export function mapAdminProduct(product: ProductWithRelations) {
  return {
    id: product.id,
    companyId: product.companyId,
    slug: product.slug,
    active: product.active,
    showInCatalog: product.showInCatalog,
    pauseHumanAfterSale: product.pauseHumanAfterSale,
    productType: product.productType,
    name: product.name,
    price: product.price,
    regularPrice: product.regularPrice,
    // Oferta con vigencia (campos crudos para el panel/copiloto + flag calculado).
    offerPrice: product.offerPrice ?? null,
    offerStartsAt: product.offerStartsAt ?? null,
    offerEndsAt: product.offerEndsAt ?? null,
    offerActive: offerIsActive(product),
    stock: product.stock,
    shortDescription: product.shortDescription,
    fullDescription: product.fullDescription,
    presentationMessage: product.presentationMessage,
    presentationMessageMediaUrl: product.presentationMessageMediaUrl || null,
    presentationMessageMediaType: product.presentationMessageMediaType || null,
    presentationFollowups: normalizeFollowupList(product.presentationFollowups),
    deliveryMethod: product.deliveryMethod,
    support: product.support,
    attributes: (product.attributes ?? null) as Record<string, unknown> | null,
    category: product.category ?? null,
    verticalData: (product.verticalData ?? null) as Record<string, unknown> | null,
    reminderConfig: (product.reminderConfig ?? null) as Record<string, unknown> | null,
    // Agenda de citas (rubro SERVICE): el panel y el widget necesitan estos datos.
    durationMin: product.durationMin,
    slotCapacity: product.slotCapacity,
    bookingLeadMinutes: product.bookingLeadMinutes,
    bookingHorizonDays: product.bookingHorizonDays,
    sortOrder: product.sortOrder,
    aliases: product.aliases.map((item) => item.value),
    benefits: product.benefits.map((item) => item.value),
    includes: product.includes.map((item) => item.value),
    bonuses: product.bonuses.map((item) => item.value),
    faqs: product.faqs.map((item) => ({
      question: item.question,
      answer: item.answer,
      sortOrder: item.sortOrder,
    })),
    objections: product.objections.map((item) => ({
      question: item.question,
      answer: item.answer,
      sortOrder: item.sortOrder,
    })),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      options: jsonArrayToStrings(variant.options),
      sortOrder: variant.sortOrder,
    })),
    files: product.files.map((file) => ({
      id: file.id,
      type: file.type,
      url: file.url,
      storagePath: file.storagePath,
      originalName: file.originalName,
      extension: file.extension,
      mimeType: file.mimeType,
      size: file.size,
      description: file.description,
      sortOrder: file.sortOrder,
      showInPresentation: file.showInPresentation,
    })),
    digitalDelivery: product.digitalDelivery,
    physicalDelivery: product.physicalDelivery
      ? {
          requiresAddress: product.physicalDelivery.requiresAddress,
          deliveryCost: product.physicalDelivery.deliveryCost,
          deliveryTime: product.physicalDelivery.deliveryTime,
          pickupAvailable: product.physicalDelivery.pickupAvailable,
          deliveryAreas: jsonArrayToStrings(product.physicalDelivery.deliveryAreas),
        }
      : null,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export function mapBotProduct(
  product: ProductWithRelations,
  opts?: { currencySymbol?: string; timezone?: string },
) {
  // TODO: leer currencySymbol de Company.currencySymbol cuando se agregue la columna
  const symbol = opts?.currencySymbol ?? "S/";
  // El símbolo solo se antepone a precios que EMPIEZAN en número; los textos
  // libres ("Consultar", "Según el plan elegido") se muestran tal cual.
  const fmtPrice = (v: string | null | undefined) => {
    if (v === null || v === undefined || v.trim() === "") return null;
    return /^\d/.test(v.trim()) ? `${symbol} ${v}` : v;
  };

  // Oferta VIGENTE: el precio EFECTIVO pasa a ser el de oferta y el precio
  // normal queda como "antes" (tachado). Todo el runtime (catálogo del prompt,
  // ficha, carrito, enviar_metodos_pago, validar_pago) lee price/priceText de
  // aquí, así que hereda la oferta sin lógica adicional.
  const offerActive = offerIsActive(product);
  const effectivePrice = offerActive ? (product.offerPrice as string) : product.price;
  const effectiveRegular = offerActive ? product.price : product.regularPrice;

  return {
    id: product.id,               // UUID real (antes era product.slug)
    slug: product.slug,           // identificador amigable para conversación / URL
    code: product.slug,           // alias de slug, para uso en n8n
    active: product.active,
    showInCatalog: product.showInCatalog,
    pauseHumanAfterSale: product.pauseHumanAfterSale,
    productType: product.productType.toLowerCase(),
    name: product.name,
    aliases: product.aliases.map((item) => item.value),
    price: effectivePrice,
    priceText: fmtPrice(effectivePrice),
    regularPrice: effectiveRegular,
    regularPriceText: fmtPrice(effectiveRegular),
    offerActive,
    offerEndsAt: offerActive ? product.offerEndsAt ?? null : null,
    // Fin de la oferta formateado en el timezone del negocio (para urgencia en ficha/catálogo).
    offerEndsText:
      offerActive && product.offerEndsAt
        ? new Intl.DateTimeFormat("es-PE", {
            timeZone: opts?.timezone || "America/Lima",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(product.offerEndsAt)
        : null,
    stock: product.stock,
    shortDescription: product.shortDescription,
    fullDescription: product.fullDescription,
    presentationMessage: product.presentationMessage,
    presentationMessageMediaUrl: product.presentationMessageMediaUrl || null,
    presentationMessageMediaType: product.presentationMessageMediaType || null,
    presentationFollowups: normalizeFollowupList(product.presentationFollowups),
    deliveryMethod: product.deliveryMethod,
    support: product.support,
    attributes: (product.attributes ?? null) as Record<string, unknown> | null,
    category: product.category ?? null,
    verticalData: (product.verticalData ?? null) as Record<string, unknown> | null,
    reminderConfig: (product.reminderConfig ?? null) as Record<string, unknown> | null,
    benefits: product.benefits.map((item) => item.value),
    includes: product.includes.map((item) => item.value),
    bonuses: product.bonuses.map((item) => item.value),
    faqs: product.faqs.map((item) => ({
      question: item.question,
      answer: item.answer,
      sortOrder: item.sortOrder,
    })),
    objections: product.objections.map((item) => ({
      question: item.question,
      answer: item.answer,
      sortOrder: item.sortOrder,
    })),
    variants: product.variants.map((variant) => ({
      name: variant.name,
      options: jsonArrayToStrings(variant.options),
      sortOrder: variant.sortOrder,
    })),
    files: product.files.map((file) => ({
      id: file.id,
      type: file.type.toLowerCase(),
      url: file.url,
      originalName: file.originalName || null,
      description: file.description,
      sortOrder: file.sortOrder,
      showInPresentation: file.showInPresentation,
    })),
    digitalDelivery:
      product.productType === "DIGITAL"
        ? {
            link: product.digitalDelivery?.link ?? null,
            instructions: product.digitalDelivery?.instructions ?? null,
            assignmentMode: product.digitalDelivery?.assignmentMode ?? "STATIC",
            followupMessages: normalizeFollowups(product.digitalDelivery),
            crossSellProductId: product.digitalDelivery?.crossSellProductId ?? null,
            crossSellPitch: product.digitalDelivery?.crossSellPitch ?? null,
            crossSellPitchMediaUrl: product.digitalDelivery?.crossSellPitchMediaUrl ?? null,
            crossSellPitchMediaType: product.digitalDelivery?.crossSellPitchMediaType ?? null,
            onSaleCrmId: product.digitalDelivery?.onSaleCrmId ?? null,
            onSaleCrmColumnId: product.digitalDelivery?.onSaleCrmColumnId ?? null,
            onSaleTagIds: product.digitalDelivery?.onSaleTagIds ?? [],
            onSaleRemoveTagIds: product.digitalDelivery?.onSaleRemoveTagIds ?? [],
            onPresentationCrmId: product.digitalDelivery?.onPresentationCrmId ?? null,
            onPresentationCrmColumnId: product.digitalDelivery?.onPresentationCrmColumnId ?? null,
            onPresentationTagIds: product.digitalDelivery?.onPresentationTagIds ?? [],
            onPresentationRemoveTagIds: product.digitalDelivery?.onPresentationRemoveTagIds ?? [],
            onPaymentCrmId: product.digitalDelivery?.onPaymentCrmId ?? null,
            onPaymentCrmColumnId: product.digitalDelivery?.onPaymentCrmColumnId ?? null,
            onPaymentTagIds: product.digitalDelivery?.onPaymentTagIds ?? [],
            onPaymentRemoveTagIds: product.digitalDelivery?.onPaymentRemoveTagIds ?? [],
          }
        : null,
    physicalDelivery:
      product.productType === "PHYSICAL"
        ? {
            requiresAddress: product.physicalDelivery?.requiresAddress ?? true,
            deliveryCost: product.physicalDelivery?.deliveryCost ?? null,
            deliveryTime: product.physicalDelivery?.deliveryTime ?? null,
            pickupAvailable: product.physicalDelivery?.pickupAvailable ?? false,
            deliveryAreas: jsonArrayToStrings(product.physicalDelivery?.deliveryAreas),
          }
        : null,
  };
}
