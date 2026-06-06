import { BusinessVertical, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

export async function getBusinessProfile(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { _count: { select: { products: true } } },
  });

  if (!company) {
    throw new AppError("Empresa no encontrada", 404);
  }

  const { _count, ...rest } = company;
  return { ...rest, productCount: _count.products };
}

export interface DeliveryConfigInput {
  cost?: string | null;
  time?: string | null;
  areas?: string[];
  pickupAvailable?: boolean;
  requiresAddress?: boolean;
}

export async function updateBusinessProfile(companyId: string, data: {
  name: string;
  slug: string;
  adminPhone: string;
  vertical: BusinessVertical;
  timezone: string;
  isActive: boolean;
  deliveryConfig?: DeliveryConfigInput | null;
}) {
  const existing = await prisma.company.findUnique({
    where: { id: companyId },
    select: { vertical: true, _count: { select: { products: true } } },
  });
  if (!existing) {
    throw new AppError("Empresa no encontrada", 404);
  }

  // Lock de rubro: no se puede cambiar el rubro si ya hay productos (toda la
  // config de producto parte del rubro; cambiarlo dejaría datos inconsistentes).
  if (data.vertical !== existing.vertical && existing._count.products > 0) {
    throw new AppError(
      "No puedes cambiar de rubro mientras tengas productos creados. Elimina tus productos primero.",
      409,
      { code: "VERTICAL_LOCKED" },
    );
  }

  const { deliveryConfig, ...rest } = data;
  const deliveryValue: Prisma.InputJsonValue | typeof Prisma.JsonNull =
    deliveryConfig == null ? Prisma.JsonNull : (deliveryConfig as Prisma.InputJsonValue);

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: { ...rest, deliveryConfig: deliveryValue },
    include: { _count: { select: { products: true } } },
  });
  const { _count, ...company } = updated;
  return { ...company, productCount: _count.products };
}
