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
    stock: product.stock,
    shortDescription: product.shortDescription,
    fullDescription: product.fullDescription,
    presentationMessage: product.presentationMessage,
    presentationFollowups: normalizeFollowupList(product.presentationFollowups),
    deliveryMethod: product.deliveryMethod,
    support: product.support,
    attributes: (product.attributes ?? null) as Record<string, unknown> | null,
    category: product.category ?? null,
    verticalData: (product.verticalData ?? null) as Record<string, unknown> | null,
    reminderConfig: (product.reminderConfig ?? null) as Record<string, unknown> | null,
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
  opts?: { currencySymbol?: string },
) {
  // TODO: leer currencySymbol de Company.currencySymbol cuando se agregue la columna
  const symbol = opts?.currencySymbol ?? "S/";
  const fmtPrice = (v: string | null | undefined) =>
    v === null || v === undefined || v === "" ? null : `${symbol} ${v}`;

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
    price: product.price,
    priceText: fmtPrice(product.price),
    regularPrice: product.regularPrice,
    regularPriceText: fmtPrice(product.regularPrice),
    stock: product.stock,
    shortDescription: product.shortDescription,
    fullDescription: product.fullDescription,
    presentationMessage: product.presentationMessage,
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
            onPresentationCrmId: product.digitalDelivery?.onPresentationCrmId ?? null,
            onPresentationCrmColumnId: product.digitalDelivery?.onPresentationCrmColumnId ?? null,
            onPresentationTagIds: product.digitalDelivery?.onPresentationTagIds ?? [],
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
