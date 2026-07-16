import crypto from "crypto";
import type { PreRegistration, PreRegistrationStatus, BusinessVertical } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { sendMail } from "../../lib/mailer";
import { env } from "../../config/env";
import { normalizePhoneDigits, normalizeUsername } from "../../lib/identifier";
import { provisionClient } from "../admin-console/admin-console.service";
import { accountActivatedEmail } from "./registration.emails";

// ---------------------------------------------------------------------------
// Gestión de pre-registros desde la consola superadmin: listar, editar,
// convertir en cuenta real (conservando la contraseña del cliente),
// rechazar y eliminar.
// ---------------------------------------------------------------------------

function mapPreRegistration(row: PreRegistration & { plan?: { id: string; name: string } | null }) {
  return {
    id: row.id,
    status: row.status,
    planId: row.planId,
    planName: row.plan?.name ?? null,
    companyName: row.companyName,
    fullName: row.fullName,
    email: row.email,
    countryCode: row.countryCode,
    phone: row.phone,
    username: row.username,
    vertical: row.vertical,
    adminNotes: row.adminNotes,
    rejectionReason: row.rejectionReason,
    convertedCompanyId: row.convertedCompanyId,
    verifiedAt: row.verifiedAt,
    convertedAt: row.convertedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
  };
}

export type PreRegistrationDto = ReturnType<typeof mapPreRegistration>;

const PLAN_SELECT = { plan: { select: { id: true, name: true } } };

export async function listPreRegistrations(status?: PreRegistrationStatus) {
  const rows = await prisma.preRegistration.findMany({
    where: status ? { status } : undefined,
    include: PLAN_SELECT,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapPreRegistration);
}

export async function countPendingPreRegistrations() {
  const count = await prisma.preRegistration.count({ where: { status: "VERIFIED" } });
  return { count };
}

export interface UpdatePreRegistrationInput {
  planId?: string | null;
  vertical?: BusinessVertical;
  companyName?: string;
  fullName?: string;
  email?: string;
  countryCode?: string;
  phone?: string;
  username?: string;
  adminNotes?: string | null;
}

export async function updatePreRegistration(id: string, input: UpdatePreRegistrationInput) {
  const prereg = await prisma.preRegistration.findUnique({ where: { id } });
  if (!prereg) throw new AppError("Pre-registro no encontrado", 404);
  if (prereg.status !== "EMAIL_PENDING" && prereg.status !== "VERIFIED") {
    throw new AppError("Solo se pueden editar pre-registros abiertos", 409);
  }

  if (input.planId) {
    const plan = await prisma.platformPlan.findFirst({ where: { id: input.planId, isActive: true } });
    if (!plan) throw new AppError("Paquete no encontrado o inactivo", 404);
  }

  // Colisiones si cambian email/phone/username (contra Users y otros preregs abiertos).
  // El phone editado llega COMPLETO (con código de país), igual que se almacena.
  const username = input.username ? normalizeUsername(input.username) : undefined;
  const fullPhone = input.phone !== undefined ? normalizePhoneDigits(input.phone) : undefined;

  if (username && username !== prereg.username) {
    const clash = await prisma.user.findUnique({ where: { username } });
    if (clash) throw new AppError("Ese usuario ya está en uso", 409);
  }
  if (input.email && input.email !== prereg.email) {
    const clash = await prisma.user.findFirst({ where: { email: input.email } });
    if (clash) throw new AppError("Ya existe una cuenta con ese correo", 409);
  }

  const updated = await prisma.preRegistration.update({
    where: { id },
    data: {
      ...(input.planId !== undefined ? { planId: input.planId } : {}),
      ...(input.vertical ? { vertical: input.vertical } : {}),
      ...(input.companyName ? { companyName: input.companyName } : {}),
      ...(input.fullName ? { fullName: input.fullName } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.countryCode ? { countryCode: input.countryCode } : {}),
      ...(fullPhone ? { phone: fullPhone } : {}),
      ...(username ? { username } : {}),
      ...(input.adminNotes !== undefined ? { adminNotes: input.adminNotes } : {}),
    },
    include: PLAN_SELECT,
  });
  return mapPreRegistration(updated);
}

export interface ConvertPreRegistrationInput {
  slug: string;
  planMonths?: number;
  whatsappProvider?: "SMSTOOLS" | "META";
  isActive?: boolean;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  metaWabaId?: string;
}

export async function convertPreRegistration(id: string, input: ConvertPreRegistrationInput) {
  const prereg = await prisma.preRegistration.findUnique({ where: { id } });
  if (!prereg) throw new AppError("Pre-registro no encontrado", 404);
  if (prereg.status !== "VERIFIED") {
    throw new AppError("Solo se pueden activar pre-registros con el correo verificado", 409);
  }
  if (!prereg.passwordHash) {
    throw new AppError("El pre-registro ya no tiene credenciales (¿ya fue convertido?)", 409);
  }

  // La cuenta de SMS Tools necesita una password propia: es interna del
  // proveedor (el cliente nunca la usa) — se genera una aleatoria.
  const smsToolsPassword = crypto.randomBytes(18).toString("base64url");

  const client = await provisionClient({
    companyName: prereg.companyName,
    slug: input.slug,
    adminName: prereg.fullName,
    adminEmail: prereg.email,
    adminPhone: prereg.phone,
    passwordHash: prereg.passwordHash,
    smsToolsPassword,
    timezone: "America/Lima",
    isActive: input.isActive ?? true,
    whatsappProvider: input.whatsappProvider ?? "SMSTOOLS",
    planId: prereg.planId ?? undefined,
    planMonths: input.planMonths ?? 1,
    vertical: prereg.vertical,
    username: prereg.username,
    email: prereg.email,
    metaAccessToken: input.metaAccessToken,
    metaPhoneNumberId: input.metaPhoneNumberId,
    metaWabaId: input.metaWabaId,
  });

  // Guard anti doble-click: solo el primer convert gana. Se limpia el hash
  // (ya vive en el User real) para no retener credenciales en el prereg.
  const marked = await prisma.preRegistration.updateMany({
    where: { id, status: "VERIFIED" },
    data: {
      status: "CONVERTED",
      convertedAt: new Date(),
      convertedCompanyId: client.id,
      passwordHash: "",
    },
  });
  if (marked.count === 0) {
    console.warn("[registration] conversión duplicada detectada para prereg", id);
  }

  // Aviso al cliente (best-effort; nunca rompe la conversión).
  try {
    await sendMail({
      to: prereg.email,
      ...accountActivatedEmail({
        name: prereg.fullName,
        username: prereg.username,
        loginUrl: env.FRONTEND_URL ? `${env.FRONTEND_URL.replace(/\/$/, "")}/login` : undefined,
      }),
    });
  } catch {
    /* best-effort */
  }

  return client;
}

export async function rejectPreRegistration(id: string, reason?: string) {
  const prereg = await prisma.preRegistration.findUnique({ where: { id } });
  if (!prereg) throw new AppError("Pre-registro no encontrado", 404);
  if (prereg.status !== "EMAIL_PENDING" && prereg.status !== "VERIFIED") {
    throw new AppError("Solo se pueden rechazar pre-registros abiertos", 409);
  }
  const updated = await prisma.preRegistration.update({
    where: { id },
    data: { status: "REJECTED", rejectedAt: new Date(), rejectionReason: reason ?? null },
    include: PLAN_SELECT,
  });
  return mapPreRegistration(updated);
}

export async function deletePreRegistration(id: string) {
  const prereg = await prisma.preRegistration.findUnique({ where: { id }, select: { id: true } });
  if (!prereg) throw new AppError("Pre-registro no encontrado", 404);
  await prisma.preRegistration.delete({ where: { id } });
}
