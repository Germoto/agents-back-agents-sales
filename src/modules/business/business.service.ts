import { BusinessVertical, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { getEnabledVerticals } from "../platform-config/platform-config.service";
import { invalidateFirmaCache } from "../agent/firma";

export async function getBusinessProfile(companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { _count: { select: { products: true } } },
  });

  if (!company) {
    throw new AppError("Empresa no encontrada", 404);
  }

  const { _count, ...rest } = company;
  // Rubros que el cliente puede elegir = habilitados globalmente ∪ su rubro actual
  // (para que su selección actual nunca desaparezca del selector aunque luego se
  // deshabilite globalmente).
  const enabled = await getEnabledVerticals();
  const enabledVerticals = enabled.includes(rest.vertical)
    ? enabled
    : [...enabled, rest.vertical];
  return { ...rest, productCount: _count.products, enabledVerticals };
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
  botMode?: "AI" | "FLOW";
  isActive: boolean;
  deliveryConfig?: DeliveryConfigInput | null;
  firmaEnabled?: boolean;
  firmaText?: string | null;
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

  // Solo se puede cambiar a un rubro habilitado por el superadmin (no aplica si no
  // cambia el rubro, para no bloquear ediciones de empresas con rubro ya deshabilitado).
  if (data.vertical !== existing.vertical) {
    const enabled = await getEnabledVerticals();
    if (!enabled.includes(data.vertical)) {
      throw new AppError(
        "Ese rubro no está disponible. Elige uno de los rubros habilitados.",
        409,
        { code: "VERTICAL_NOT_ENABLED" },
      );
    }
  }

  const { deliveryConfig, ...rest } = data;
  const deliveryValue: Prisma.InputJsonValue | typeof Prisma.JsonNull =
    deliveryConfig == null ? Prisma.JsonNull : (deliveryConfig as Prisma.InputJsonValue);

  const updated = await prisma.company.update({
    where: { id: companyId },
    data: { ...rest, deliveryConfig: deliveryValue },
    include: { _count: { select: { products: true } } },
  });
  // La firma se cachea en el módulo de entrega: invalidar tras guardar.
  invalidateFirmaCache(companyId);
  const { _count, ...company } = updated;
  return { ...company, productCount: _count.products };
}
