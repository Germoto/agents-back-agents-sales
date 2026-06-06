import { Prisma } from "@prisma/client";
import fs from "fs/promises";
import path from "path";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { mapAdminProduct, productRelations } from "../../lib/product";
import { env } from "../../config/env";

type ProductPayload = {
  slug: string;
  active: boolean;
  productType?: "DIGITAL" | "PHYSICAL";
  name: string;
  price: string;
  regularPrice?: string | null;
  stock?: number | null;
  shortDescription: string;
  fullDescription?: string;
  deliveryMethod?: string | null;
  support?: string | null;
  attributes?: Record<string, string> | null;
  category?: string | null;
  verticalData?: Record<string, unknown> | null;
  reminderConfig?: Record<string, unknown> | null;
  sortOrder: number;
  aliases: string[];
  benefits: Array<{ value: string; sortOrder: number }>;
  includes: Array<{ value: string; sortOrder: number }>;
  bonuses: Array<{ value: string; sortOrder: number }>;
  faqs: Array<{ question: string; answer: string; sortOrder: number }>;
  objections: Array<{ question: string; answer: string; sortOrder: number }>;
  files: Array<{
    id?: string;
    type: "IMAGE" | "PDF" | "VIDEO" | "AUDIO" | "OTHER";
    url: string;
    storagePath: string;
    originalName: string;
    extension: string;
    mimeType: string;
    size: number;
    description: string;
    sortOrder: number;
  }>;
  digitalDelivery?: {
    link?: string;
    instructions?: string;
  } | null;
  physicalDelivery?: {
    requiresAddress: boolean;
    deliveryCost?: string | null;
    deliveryTime?: string | null;
    pickupAvailable: boolean;
    deliveryAreas: string[];
  } | null;
  variants: Array<{ name: string; options: string[]; sortOrder: number }>;
};

// El tipo (mecanismo de entrega) se deriva del rubro de la empresa; para OTHER se
// respeta lo enviado por el cliente.
async function resolveProductType(
  companyId: string,
  payloadType?: "DIGITAL" | "PHYSICAL",
): Promise<"DIGITAL" | "PHYSICAL"> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { vertical: true },
  });
  const v = company?.vertical;
  if (v === "RESTAURANT" || v === "PHYSICAL_GOODS") return "PHYSICAL";
  if (v === "INFOPRODUCT" || v === "STREAMER" || v === "SERVICE") return "DIGITAL";
  return payloadType ?? "DIGITAL"; // OTHER
}

async function ensureProductBelongsToCompany(companyId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId },
  });

  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }

  return product;
}

async function safeUnlinkStorage(storagePath: string | null | undefined) {
  if (!storagePath) return;
  const normalized = storagePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith("products/") || normalized.includes("..")) return;
  const absolute = path.resolve(process.cwd(), env.UPLOAD_DIR, normalized);
  try {
    await fs.unlink(absolute);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[products] No se pudo eliminar archivo:", absolute, err?.message);
    }
  }
}

async function syncProductFiles(
  tx: Prisma.TransactionClient,
  productId: string,
  files: ProductPayload["files"],
) {
  const existing = await tx.productFile.findMany({ where: { productId } });
  const existingById = new Map(existing.map((f) => [f.id, f] as const));
  const incomingIds = new Set(files.filter((f) => f.id).map((f) => f.id as string));

  // Delete files no longer present
  const toRemove = existing.filter((f) => !incomingIds.has(f.id));
  if (toRemove.length) {
    await tx.productFile.deleteMany({
      where: { id: { in: toRemove.map((f) => f.id) } },
    });
    // physical removal happens after the transaction completes successfully (best effort)
    for (const f of toRemove) {
      await safeUnlinkStorage(f.storagePath);
    }
  }

  // Upsert each incoming
  for (const file of files) {
    const data = {
      type: file.type,
      url: file.url,
      storagePath: file.storagePath,
      originalName: file.originalName ?? "",
      extension: file.extension ?? "",
      mimeType: file.mimeType ?? "",
      size: file.size ?? 0,
      description: file.description ?? "",
      sortOrder: file.sortOrder ?? 0,
    } satisfies Prisma.ProductFileUncheckedUpdateInput;

    if (file.id && existingById.has(file.id)) {
      await tx.productFile.update({
        where: { id: file.id },
        data,
      });
    } else {
      await tx.productFile.create({
        data: {
          productId,
          ...data,
        } as Prisma.ProductFileUncheckedCreateInput,
      });
    }
  }
}

async function writeProductGraph(tx: Prisma.TransactionClient, productId: string, payload: ProductPayload) {
  await tx.productAlias.deleteMany({ where: { productId } });
  await tx.productBenefit.deleteMany({ where: { productId } });
  await tx.productInclude.deleteMany({ where: { productId } });
  await tx.productBonus.deleteMany({ where: { productId } });
  await tx.productFaq.deleteMany({ where: { productId } });
  await tx.productObjection.deleteMany({ where: { productId } });
  await tx.productVariant.deleteMany({ where: { productId } });
  // ProductFile is NOT wiped here; it uses a diff/upsert strategy below
  await syncProductFiles(tx, productId, payload.files);

  if (payload.aliases.length) {
    await tx.productAlias.createMany({
      data: payload.aliases.map((value) => ({ productId, value })),
    });
  }

  if (payload.benefits.length) {
    await tx.productBenefit.createMany({
      data: payload.benefits.map((item) => ({ productId, value: item.value, sortOrder: item.sortOrder })),
    });
  }

  if (payload.includes.length) {
    await tx.productInclude.createMany({
      data: payload.includes.map((item) => ({ productId, value: item.value, sortOrder: item.sortOrder })),
    });
  }

  if (payload.bonuses.length) {
    await tx.productBonus.createMany({
      data: payload.bonuses.map((item) => ({ productId, value: item.value, sortOrder: item.sortOrder })),
    });
  }

  if (payload.faqs.length) {
    await tx.productFaq.createMany({
      data: payload.faqs.map((item) => ({ productId, question: item.question, answer: item.answer, sortOrder: item.sortOrder })),
    });
  }

  if (payload.objections.length) {
    await tx.productObjection.createMany({
      data: payload.objections.map((item) => ({ productId, question: item.question, answer: item.answer, sortOrder: item.sortOrder })),
    });
  }

  if (payload.variants.length) {
    await tx.productVariant.createMany({
      data: payload.variants.map((item) => ({
        productId,
        name: item.name,
        options: item.options,
        sortOrder: item.sortOrder,
      })),
    });
  }

  if (payload.files.length === 0) {
    // handled by syncProductFiles; nothing to do here
  }

  if (payload.digitalDelivery) {
    // Columnas no-nulas: default a "" si vienen vacías (borrador sin link).
    const dd = {
      link: payload.digitalDelivery.link ?? "",
      instructions: payload.digitalDelivery.instructions ?? "",
    };
    await tx.digitalDelivery.upsert({
      where: { productId },
      update: dd,
      create: { productId, ...dd },
    });
  } else {
    await tx.digitalDelivery.deleteMany({ where: { productId } });
  }

  if (payload.physicalDelivery) {
    await tx.physicalDelivery.upsert({
      where: { productId },
      update: payload.physicalDelivery,
      create: {
        productId,
        ...payload.physicalDelivery,
      },
    });
  } else {
    await tx.physicalDelivery.deleteMany({ where: { productId } });
  }
}

export async function listProducts(companyId: string) {
  const products = await prisma.product.findMany({
    where: { companyId },
    include: productRelations,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
  });

  return products.map(mapAdminProduct);
}

export async function getProduct(companyId: string, productId: string) {
  await ensureProductBelongsToCompany(companyId, productId);

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: productRelations,
  });

  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }

  return mapAdminProduct(product);
}

export async function createProduct(companyId: string, payload: ProductPayload) {
  const productType = await resolveProductType(companyId, payload.productType);
  const product = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.product.create({
      data: {
        companyId,
        slug: payload.slug,
        active: payload.active,
        productType,
        name: payload.name,
        price: payload.price,
        regularPrice: payload.regularPrice ?? null,
        stock: payload.stock ?? null,
        shortDescription: payload.shortDescription,
        fullDescription: payload.fullDescription ?? "",
        deliveryMethod: payload.deliveryMethod ?? null,
        support: payload.support ?? null,
        attributes: payload.attributes == null ? Prisma.JsonNull : (payload.attributes as Prisma.InputJsonValue),
        category: payload.category ?? null,
        verticalData: payload.verticalData == null ? Prisma.JsonNull : (payload.verticalData as Prisma.InputJsonValue),
        reminderConfig: payload.reminderConfig == null ? Prisma.JsonNull : (payload.reminderConfig as Prisma.InputJsonValue),
        sortOrder: payload.sortOrder,
      },
    });

    await writeProductGraph(tx, created.id, payload);

    return tx.product.findUniqueOrThrow({
      where: { id: created.id },
      include: productRelations,
    });
  });

  return mapAdminProduct(product);
}

export async function updateProduct(companyId: string, productId: string, payload: ProductPayload) {
  await ensureProductBelongsToCompany(companyId, productId);
  const productType = await resolveProductType(companyId, payload.productType);

  const product = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        slug: payload.slug,
        active: payload.active,
        productType,
        name: payload.name,
        price: payload.price,
        regularPrice: payload.regularPrice ?? null,
        stock: payload.stock ?? null,
        shortDescription: payload.shortDescription,
        fullDescription: payload.fullDescription ?? "",
        deliveryMethod: payload.deliveryMethod ?? null,
        support: payload.support ?? null,
        attributes: payload.attributes == null ? Prisma.JsonNull : (payload.attributes as Prisma.InputJsonValue),
        category: payload.category ?? null,
        verticalData: payload.verticalData == null ? Prisma.JsonNull : (payload.verticalData as Prisma.InputJsonValue),
        reminderConfig: payload.reminderConfig == null ? Prisma.JsonNull : (payload.reminderConfig as Prisma.InputJsonValue),
        sortOrder: payload.sortOrder,
      },
    });

    await writeProductGraph(tx, productId, payload);

    return tx.product.findUniqueOrThrow({
      where: { id: productId },
      include: productRelations,
    });
  });

  return mapAdminProduct(product);
}

export async function deleteProduct(companyId: string, productId: string) {
  await ensureProductBelongsToCompany(companyId, productId);
  await prisma.product.delete({ where: { id: productId } });
  return { success: true };
}

export async function toggleProductActive(companyId: string, productId: string) {
  await ensureProductBelongsToCompany(companyId, productId);
  const current = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  const updated = await prisma.product.update({
    where: { id: productId },
    data: { active: !current.active },
  });
  return { id: updated.id, active: updated.active };
}
