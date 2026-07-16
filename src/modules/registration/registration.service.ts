import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { normalizePhoneDigits, normalizeUsername } from "../../lib/identifier";
import { verificationCodeEmail } from "./registration.emails";

// ---------------------------------------------------------------------------
// Pre-registro público: el cliente se registra desde el landing, verifica su
// correo con un código de 6 dígitos y queda VERIFIED a la espera de que el
// superadmin convierta la solicitud en cuenta real desde la consola.
// ---------------------------------------------------------------------------

const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutos
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export interface CreatePreRegistrationInput {
  planId?: string;
  companyName: string;
  fullName: string;
  email: string; // ya lowercase por el schema
  countryCode: string;
  phone: string; // solo dígitos, sin código de país
  username: string; // ya lowercase por el schema
  password: string;
}

/** Celular completo (dígitos del código de país + número). */
function fullPhoneOf(countryCode: string, phone: string): string {
  return `${normalizePhoneDigits(countryCode)}${phone}`;
}

async function assertNoCollisions(
  input: { email: string; fullPhone: string; username: string },
  excludePreRegId?: string,
) {
  // Contra usuarios reales
  const [emailUser, phoneUser, usernameUser] = await Promise.all([
    prisma.user.findFirst({ where: { email: input.email } }),
    prisma.user.findFirst({ where: { phone: { in: [input.fullPhone, `+${input.fullPhone}`] } } }),
    prisma.user.findUnique({ where: { username: input.username } }),
  ]);
  if (emailUser) throw new AppError("Ya existe una cuenta con ese correo. Inicia sesión.", 409);
  if (phoneUser) throw new AppError("Ya existe una cuenta con ese celular. Inicia sesión.", 409);
  if (usernameUser) throw new AppError("Ese usuario ya está en uso. Elige otro.", 409);

  // Contra otros pre-registros abiertos
  const clash = await prisma.preRegistration.findFirst({
    where: {
      status: { in: ["EMAIL_PENDING", "VERIFIED"] },
      ...(excludePreRegId ? { id: { not: excludePreRegId } } : {}),
      OR: [{ email: input.email }, { phone: input.fullPhone }, { username: input.username }],
    },
  });
  if (clash) {
    if (clash.email === input.email) throw new AppError("Ya hay un registro en proceso con ese correo.", 409);
    if (clash.phone === input.fullPhone) throw new AppError("Ya hay un registro en proceso con ese celular.", 409);
    throw new AppError("Ese usuario ya está en uso. Elige otro.", 409);
  }
}

export async function createPreRegistration(input: CreatePreRegistrationInput) {
  if (!mailerEnabled()) {
    throw new AppError("El registro no está disponible en este momento. Escríbenos por WhatsApp.", 503);
  }

  const fullPhone = fullPhoneOf(input.countryCode, input.phone);
  const username = normalizeUsername(input.username);

  // Plan elegido: debe ser público y activo (o ninguno).
  if (input.planId) {
    const plan = await prisma.platformPlan.findFirst({
      where: { id: input.planId, isActive: true, isPublic: true },
    });
    if (!plan) throw new AppError("El plan elegido ya no está disponible.", 404);
  }

  // Re-intento del MISMO usuario: si hay un EMAIL_PENDING con ese correo,
  // se actualiza esa fila (datos + código nuevo) respetando el cooldown.
  const existing = await prisma.preRegistration.findFirst({
    where: { status: "EMAIL_PENDING", email: input.email },
  });

  await assertNoCollisions({ email: input.email, fullPhone, username }, existing?.id);

  if (existing?.emailCodeSentAt && Date.now() - existing.emailCodeSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new AppError("Ya te enviamos un código hace un momento. Revisa tu correo.", 429);
  }

  const code = generateCode();
  const passwordHash = await bcrypt.hash(input.password, 10);

  // Enviar ANTES de persistir: si el correo falla no queda un registro colgado.
  await sendMail({ to: input.email, ...verificationCodeEmail({ name: input.fullName, code }) });

  const data = {
    planId: input.planId ?? null,
    companyName: input.companyName,
    fullName: input.fullName,
    email: input.email,
    countryCode: input.countryCode,
    phone: fullPhone,
    username,
    passwordHash,
    emailCodeHash: sha256(code),
    emailCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
    emailCodeAttempts: 0,
    emailCodeSentAt: new Date(),
  };

  const row = existing
    ? await prisma.preRegistration.update({ where: { id: existing.id }, data })
    : await prisma.preRegistration.create({ data });

  return { id: row.id, email: row.email };
}

export async function verifyEmailCode(id: string, code: string) {
  const prereg = await prisma.preRegistration.findUnique({ where: { id } });
  if (!prereg || prereg.status !== "EMAIL_PENDING") {
    throw new AppError("Registro no encontrado o ya verificado", 404);
  }
  if (!prereg.emailCodeHash || !prereg.emailCodeExpiresAt || prereg.emailCodeExpiresAt.getTime() < Date.now()) {
    throw new AppError("El código venció. Solicita uno nuevo.", 410);
  }
  if (prereg.emailCodeAttempts >= MAX_CODE_ATTEMPTS) {
    throw new AppError("Demasiados intentos. Solicita un código nuevo.", 429);
  }
  if (sha256(code) !== prereg.emailCodeHash) {
    await prisma.preRegistration.update({
      where: { id },
      data: { emailCodeAttempts: { increment: 1 } },
    });
    throw new AppError("Código incorrecto", 401);
  }

  await prisma.preRegistration.update({
    where: { id },
    data: {
      status: "VERIFIED",
      verifiedAt: new Date(),
      emailCodeHash: null,
      emailCodeExpiresAt: null,
      emailCodeAttempts: 0,
    },
  });

  return { verified: true };
}

export async function resendEmailCode(id: string) {
  if (!mailerEnabled()) {
    throw new AppError("El envío de correos no está disponible en este momento.", 503);
  }
  const prereg = await prisma.preRegistration.findUnique({ where: { id } });
  if (!prereg || prereg.status !== "EMAIL_PENDING") {
    throw new AppError("Registro no encontrado o ya verificado", 404);
  }
  if (prereg.emailCodeSentAt && Date.now() - prereg.emailCodeSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new AppError("Espera un momento antes de reenviar el código.", 429);
  }

  const code = generateCode();
  await sendMail({ to: prereg.email, ...verificationCodeEmail({ name: prereg.fullName, code }) });

  await prisma.preRegistration.update({
    where: { id },
    data: {
      emailCodeHash: sha256(code),
      emailCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      emailCodeAttempts: 0,
      emailCodeSentAt: new Date(),
    },
  });

  return { sent: true };
}

/**
 * Fallback del login: pre-registrado VERIFIED con credenciales correctas →
 * el frontend muestra la pantalla "Activación en proceso" (sin token).
 */
export async function findPendingActivation(identifier: string, password: string) {
  const value = identifier.trim();
  const prereg = await prisma.preRegistration.findFirst({
    where: {
      status: { in: ["EMAIL_PENDING", "VERIFIED"] },
      OR: [{ phone: normalizePhoneDigits(value) }, { username: normalizeUsername(value) }],
    },
  });
  if (!prereg || !prereg.passwordHash) return null;
  const valid = await bcrypt.compare(password, prereg.passwordHash);
  if (!valid) return null;

  if (prereg.status === "EMAIL_PENDING") {
    throw new AppError("Verifica tu correo para completar tu registro.", 401);
  }
  return {
    pendingActivation: true as const,
    name: prereg.fullName,
    email: prereg.email,
    companyName: prereg.companyName,
  };
}
