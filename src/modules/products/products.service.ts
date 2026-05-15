import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { mapAdminProduct, productRelations } from "../../lib/product";

type ProductPayload = {
  slug: string;
  active: boolean;
  productType: "DIGITAL" | "PHYSICAL";
  name: string;
  price: string;
  regularPrice?: string | null;
  stock?: number | null;
  shortDescription: string;
  fullDescription: string;
  deliveryMethod?: string | null;
  support?: string | null;
  sortOrder: number;
  aliases: string[];
  benefits: Array<{ value: string; sortOrder: number }>;
  includes: Array<{ value: string; sortOrder: number }>;
  bonuses: Array<{ value: string; sortOrder: number }>;
  faqs: Array<{ question: string; answer: string; sortOrder: number }>;
  objections: Array<{ question: string; answer: string; sortOrder: number }>;
  files: Array<{
    type: "IMAGE" | "PDF" | "VIDEO" | "OTHER";
    url: string;
    description: string;
    sortOrder: number;
  }>;
  digitalDelivery?: {
    link: string;
    instructions: string;
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

async function ensureProductBelongsToCompany(companyId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, companyId },
  });

  if (!product) {
    throw new AppError("Producto no encontrado", 404);
  }

  return product;
}

async function writeProductGraph(tx: Prisma.TransactionClient, productId: string, payload: ProductPayload) {
  await tx.productAlias.deleteMany({ where: { productId } });
  await tx.productBenefit.deleteMany({ where: { productId } });
  await tx.productInclude.deleteMany({ where: { productId } });
  await tx.productBonus.deleteMany({ where: { productId } });
  await tx.productFaq.deleteMany({ where: { productId } });
  await tx.productObjection.deleteMany({ where: { productId } });
  await tx.productVariant.deleteMany({ where: { productId } });
  await tx.productFile.deleteMany({ where: { productId } });

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

  if (payload.files.length) {
    await tx.productFile.createMany({
      data: payload.files.map((item) => ({
        productId,
        type: item.type,
        url: item.url,
        description: item.description,
        sortOrder: item.sortOrder,
      })),
    });
  }

  if (payload.digitalDelivery) {
    await tx.digitalDelivery.upsert({
      where: { productId },
      update: payload.digitalDelivery,
      create: {
        productId,
        ...payload.digitalDelivery,
      },
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
  const product = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.product.create({
      data: {
        companyId,
        slug: payload.slug,
        active: payload.active,
        productType: payload.productType,
        name: payload.name,
        price: payload.price,
        regularPrice: payload.regularPrice ?? null,
        stock: payload.stock ?? null,
        shortDescription: payload.shortDescription,
        fullDescription: payload.fullDescription,
        deliveryMethod: payload.deliveryMethod ?? null,
        support: payload.support ?? null,
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

  const product = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        slug: payload.slug,
        active: payload.active,
        productType: payload.productType,
        name: payload.name,
        price: payload.price,
        regularPrice: payload.regularPrice ?? null,
        stock: payload.stock ?? null,
        shortDescription: payload.shortDescription,
        fullDescription: payload.fullDescription,
        deliveryMethod: payload.deliveryMethod ?? null,
        support: payload.support ?? null,
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
