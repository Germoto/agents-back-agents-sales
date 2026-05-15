import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

export async function getBusinessProfile(companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });

  if (!company) {
    throw new AppError("Empresa no encontrada", 404);
  }

  return company;
}

export async function updateBusinessProfile(companyId: string, data: {
  name: string;
  slug: string;
  adminPhone: string;
  timezone: string;
  isActive: boolean;
}) {
  return prisma.company.update({
    where: { id: companyId },
    data,
  });
}
