import crypto from "crypto";
import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { signAccessToken } from "../../lib/jwt";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { normalizeUsername } from "../../lib/identifier";
import { findPendingActivation } from "../registration/registration.service";
import { passwordResetCodeEmail } from "./auth.emails";

/** Busca por celular exacto O por usuario (lowercase). Compartido con el login del superadmin. */
export function findUserByIdentifier(identifier: string) {
  const value = identifier.trim();
  return prisma.user.findFirst({
    where: { OR: [{ phone: value }, { username: normalizeUsername(value) }] },
    include: { company: true },
  });
}

export async function login(identifier: string, password: string) {
  const user = await findUserByIdentifier(identifier);

  if (!user || !user.isActive) {
    // Pre-registrado verificado esperando activación: el frontend muestra la
    // pantalla "Activación en proceso" (sin token).
    const pending = await findPendingActivation(identifier, password);
    if (pending) return pending;
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
      username: user.username,
      email: user.email,
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
      username: true,
      email: true,
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

// ---------------------------------------------------------------------------
// Recuperación y cambio de contraseña (patrón OTP del pre-registro:
// código de 6 dígitos sha256, 15 min, máx 5 intentos, cooldown 60 s).
// ---------------------------------------------------------------------------

const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_RESEND_COOLDOWN_MS = 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  const visible = local.slice(0, 1);
  return `${visible}***@${domain ?? ""}`;
}

export async function requestPasswordReset(identifier: string) {
  if (!mailerEnabled()) {
    throw new AppError("La recuperación por correo no está disponible en este momento. Escríbenos por WhatsApp.", 503);
  }

  const value = identifier.trim();
  // Celular o usuario; si parece correo, buscar también por email.
  let user = await findUserByIdentifier(value);
  if (!user && value.includes("@")) {
    user = await prisma.user.findFirst({
      where: { email: value.toLowerCase() },
      include: { company: true },
    });
  }
  if (!user || !user.isActive) {
    throw new AppError("No encontramos una cuenta con ese dato. Verifica tu celular, usuario o correo.", 404);
  }
  if (!user.email) {
    throw new AppError(
      "Tu cuenta no tiene un correo registrado. Escríbenos por WhatsApp para restablecer tu contraseña.",
      409,
    );
  }
  if (user.resetCodeSentAt && Date.now() - user.resetCodeSentAt.getTime() < RESET_RESEND_COOLDOWN_MS) {
    throw new AppError("Ya te enviamos un código hace un momento. Revisa tu correo.", 429);
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await sendMail({ to: user.email, ...passwordResetCodeEmail({ name: user.name, code }) });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetCodeHash: sha256(code),
      resetCodeExpiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
      resetCodeAttempts: 0,
      resetCodeSentAt: new Date(),
    },
  });

  return { id: user.id, emailMasked: maskEmail(user.email) };
}

export async function confirmPasswordReset(id: string, code: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || !user.isActive || !user.resetCodeHash) {
    throw new AppError("Solicitud no encontrada. Vuelve a pedir un código.", 404);
  }
  if (!user.resetCodeExpiresAt || user.resetCodeExpiresAt.getTime() < Date.now()) {
    throw new AppError("El código venció. Solicita uno nuevo.", 410);
  }
  if (user.resetCodeAttempts >= RESET_MAX_ATTEMPTS) {
    throw new AppError("Demasiados intentos. Solicita un código nuevo.", 429);
  }
  if (sha256(code) !== user.resetCodeHash) {
    await prisma.user.update({ where: { id }, data: { resetCodeAttempts: { increment: 1 } } });
    throw new AppError("Código incorrecto", 401);
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id },
    data: {
      passwordHash,
      resetCodeHash: null,
      resetCodeExpiresAt: null,
      resetCodeAttempts: 0,
      resetCodeSentAt: null,
    },
  });

  return { success: true };
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError("Usuario no encontrado", 404);

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw new AppError("La contraseña actual es incorrecta", 401);

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  return { success: true };
}
