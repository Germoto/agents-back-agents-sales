import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { signAccessToken } from "../../lib/jwt";

export async function login(phone: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { phone },
    include: { company: true },
  });

  if (!user || !user.isActive) {
    throw new AppError("Credenciales invalidas", 401);
  }

  // El SUPERADMIN entra siempre por el login unificado aunque su empresa
  // "contenedora" esté inactiva (comparte companyId con una empresa real).
  if (!user.company.isActive && user.role !== "SUPERADMIN") {
    throw new AppError("La empresa esta inactiva", 403);
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);

  if (!validPassword) {
    throw new AppError("Credenciales invalidas", 401);
  }

  const accessToken = signAccessToken({
    sub: user.id,
    companyId: user.companyId,
    role: user.role,
  });

  return {
    accessToken,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      companyId: user.companyId,
      // El frontend enruta por rol: SUPERADMIN va a la consola de control.
      role: user.role,
      uiTheme: user.uiTheme,
    },
  };
}

export async function getAuthenticatedUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      phone: true,
      companyId: true,
      role: true,
      isActive: true,
      uiTheme: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new AppError("Usuario no encontrado", 404);
  }

  return user;
}

export async function updateUiTheme(userId: string, theme: Record<string, unknown>) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { uiTheme: theme as Prisma.InputJsonValue },
    select: { uiTheme: true },
  });
  return user;
}
