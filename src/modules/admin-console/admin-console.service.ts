import bcrypt from "bcrypt";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { signAccessToken } from "../../lib/jwt";
import { smsToolsAdmin, DEFAULT_API_KEY_PERMISSIONS } from "../../lib/smstools-admin-client";
import { encryptCredential } from "../../lib/credentials-crypto";
import { env } from "../../config/env";
import { addMonthsUtc } from "../billing/billing.service";
import { deriveBillingState } from "../billing/entitlements";
import { findUserByIdentifier } from "../auth/auth.service";
import { normalizeUsername, normalizePhoneDigits } from "../../lib/identifier";

function defaultRules() {
  return [
    "Responde en español.",
    "No inventes stock ni promociones.",
    "Pide datos de entrega solo cuando el cliente confirme compra.",
  ];
}

// Include compartido de los listados/detalle de clientes: usuarios admin,
// conteo de productos y (nuevo) suscripción SaaS + saldo de créditos.
const CLIENT_INCLUDE = {
  users: {
    where: { role: { in: ["ADMIN", "SUPERADMIN"] as UserRole[] } },
    orderBy: { createdAt: "asc" as const },
  },
  _count: { select: { products: true } },
  platformSubscription: { include: { plan: true } },
  wallet: true,
} satisfies Prisma.CompanyInclude;

type ClientRow = Prisma.CompanyGetPayload<{ include: typeof CLIENT_INCLUDE }>;

function mapClient(company: ClientRow) {
  const adminUser =
    company.users.find((user) => user.role === "ADMIN") ??
    company.users.find((user) => user.role === "SUPERADMIN") ??
    company.users[0] ??
    null;

  const balancePen = company.wallet ? Number(company.wallet.balancePen) : 0;
  const sub = company.platformSubscription;

  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    adminPhone: company.adminPhone,
    timezone: company.timezone,
    isActive: company.isActive,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
    adminUser: adminUser
      ? {
          id: adminUser.id,
          name: adminUser.name,
          phone: adminUser.phone,
          email: adminUser.email,
          username: adminUser.username,
          role: adminUser.role,
          isActive: adminUser.isActive,
          createdAt: adminUser.createdAt,
        }
      : null,
    productCount: company._count?.products ?? 0,
    // null = sin paquete (LEGACY, acceso libre)
    subscription: sub
      ? {
          planId: sub.planId,
          planName: sub.plan.name,
          expiresAt: sub.expiresAt,
          status: deriveBillingState(sub, balancePen).status,
        }
      : null,
    balancePen,
  };
}

export async function loginSuperadmin(identifier: string, password: string) {
  const user = await findUserByIdentifier(identifier);

  if (!user || !user.isActive || user.role !== "SUPERADMIN") {
    throw new AppError("Credenciales invalidas", 401);
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
      role: user.role,
    },
  };
}

export async function getAuthenticatedSuperadmin(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      phone: true,
      companyId: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user || user.role !== "SUPERADMIN") {
    throw new AppError("Usuario no autorizado", 403);
  }

  return user;
}

export async function listClients() {
  const companies = await prisma.company.findMany({
    include: CLIENT_INCLUDE,
    orderBy: [{ createdAt: "desc" }],
  });

  return companies.map(mapClient);
}

export async function createClient(payload: {
  companyName: string;
  slug: string;
  adminName: string;
  adminEmail: string;
  adminPhone: string;
  password: string;
  timezone: string;
  isActive: boolean;
  whatsappProvider?: "SMSTOOLS" | "META";
  planId?: string;
  planMonths?: number;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  metaWabaId?: string;
}) {
  const existingCompany = await prisma.company.findUnique({
    where: { slug: payload.slug },
    select: { id: true },
  });

  if (existingCompany) {
    throw new AppError("Ya existe un cliente con ese slug", 409);
  }

  // Validar el paquete ANTES de aprovisionar SMS Tools (fail-fast).
  const plan = payload.planId
    ? await prisma.platformPlan.findUnique({ where: { id: payload.planId } })
    : null;
  if (payload.planId && (!plan || !plan.isActive)) {
    throw new AppError("Paquete no encontrado o inactivo", 404);
  }

  const existingUser = await prisma.user.findUnique({
    where: { phone: payload.adminPhone },
    select: { id: true },
  });

  if (existingUser) {
    throw new AppError("Ya existe un usuario con ese celular", 409);
  }

  const passwordHash = await bcrypt.hash(payload.password, 10);

  const provider = payload.whatsappProvider ?? "SMSTOOLS";

  // 1) Provision the SMS TOOLS account + API key BEFORE we touch the DB
  //    so we can fail fast without leaving orphan records.
  //    Con proveedor META no hay nada que aprovisionar en SMS Tools.
  let smsToolsUserId: number | null = null;
  let smsToolsSecret: string | null = null;
  if (provider === "SMSTOOLS") {
  try {
    const createdUser = await smsToolsAdmin.createUser({
      name: payload.adminName,
      email: payload.adminEmail,
      password: payload.password,
      timezone: payload.timezone,
    });
    const parsedSmsToolsUserId = Number(createdUser?.id);
    smsToolsUserId = Number.isInteger(parsedSmsToolsUserId) && parsedSmsToolsUserId > 0 ? parsedSmsToolsUserId : null;
    if (!smsToolsUserId) {
      throw new AppError("SMS TOOLS no devolvió un id de usuario válido.", 502);
    }

    const apiKey = await smsToolsAdmin.createApiKey(
      smsToolsUserId,
      `Tenant ${payload.slug}`,
      DEFAULT_API_KEY_PERMISSIONS,
    );
    smsToolsSecret = apiKey?.secret ?? null;
    if (!smsToolsSecret) {
      throw new AppError("SMS TOOLS no devolvió el secret de la API key.", 502);
    }
  } catch (error) {
    // Best-effort rollback: if the user was created but the api key failed,
    // remove the user so we don't leave an unusable account behind.
    if (smsToolsUserId) {
      try {
        await smsToolsAdmin.deleteUser(smsToolsUserId);
      } catch {
        /* ignore secondary error */
      }
    }
    if (error instanceof AppError) throw error;
    throw new AppError(
      error instanceof Error
        ? `No se pudo aprovisionar la cuenta de SMS TOOLS: ${error.message}`
        : "No se pudo aprovisionar la cuenta de SMS TOOLS.",
      502,
    );
  }
  }

  let company;
  try {
    company = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const createdCompany = await tx.company.create({
      data: {
        name: payload.companyName,
        slug: payload.slug,
        adminPhone: payload.adminPhone,
        timezone: payload.timezone,
        isActive: payload.isActive,
      },
    });

    await tx.user.create({
      data: {
        companyId: createdCompany.id,
        name: payload.adminName,
        phone: payload.adminPhone,
        passwordHash,
        role: "ADMIN",
        isActive: payload.isActive,
      },
    });

    await tx.agentConfig.create({
      data: {
        companyId: createdCompany.id,
        openaiModel: "gpt-4.1-mini",
        openaiApiKey: "",
        temperature: "0.25",
        basePrompt: "Eres un agente vendedor por WhatsApp. Responde claro, breve y enfocado en cerrar la venta con honestidad.",
        salesStyle: "consultivo",
        rules: defaultRules(),
      },
    });

    await tx.paymentConfig.create({
      data: {
        companyId: createdCompany.id,
        enabled: true,
        paymentMode: "MANUAL",
        notificationPhone: payload.adminPhone,
      },
    });

    if (plan) {
      const now = new Date();
      const months = payload.planMonths ?? 1;
      await tx.companySubscription.create({
        data: {
          companyId: createdCompany.id,
          planId: plan.id,
          startsAt: now,
          expiresAt: addMonthsUtc(now, months),
          months,
          source: "SUPERADMIN",
        },
      });
    }

    if (provider === "META") {
      await tx.whatsappConfig.create({
        data: {
          companyId: createdCompany.id,
          provider: "META",
          // Columnas legacy de SMS Tools (NOT NULL): inertes para META.
          apiUrl: env.SMSTOOLS_API_URL,
          secret: "",
          metaAccessToken: payload.metaAccessToken ? encryptCredential(payload.metaAccessToken) : null,
          metaPhoneNumberId: payload.metaPhoneNumberId?.trim() || null,
          metaWabaId: payload.metaWabaId?.trim() || null,
          isActive: payload.isActive,
        },
      });
    } else {
      await tx.whatsappConfig.create({
        data: {
          companyId: createdCompany.id,
          apiUrl: env.SMSTOOLS_API_URL,
          secret: smsToolsSecret!,
          smsToolsUserId: smsToolsUserId,
          isActive: payload.isActive,
        },
      });
    }

    return tx.company.findUniqueOrThrow({
      where: { id: createdCompany.id },
      include: CLIENT_INCLUDE,
    });
    });
  } catch (error) {
    // Local DB write failed; roll back the SMS TOOLS user we just created.
    if (smsToolsUserId) {
      try {
        await smsToolsAdmin.deleteUser(smsToolsUserId);
      } catch {
        /* ignore secondary error */
      }
    }
    throw error;
  }

  return mapClient(company);
}

export async function updateClientStatus(companyId: string, isActive: boolean) {
  const company = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });

    if (!existing) {
      throw new AppError("Cliente no encontrado", 404);
    }

    await tx.company.update({
      where: { id: companyId },
      data: { isActive },
    });

    await tx.user.updateMany({
      where: {
        companyId,
        role: "ADMIN",
      },
      data: { isActive },
    });

    return tx.company.findUniqueOrThrow({
      where: { id: companyId },
      include: CLIENT_INCLUDE,
    });
  });

  return mapClient(company);
}

export interface UpdateClientInput {
  companyName?: string;
  adminName?: string;
  adminEmail?: string | null;
  username?: string | null;
  adminPhone?: string;
  newPassword?: string;
  timezone?: string;
}

/**
 * Edición de datos del cliente por el superadmin. Si cambia el número:
 * User.phone y Company.adminPhone se actualizan siempre; el notificationPhone
 * de pagos solo si coincidía con el número anterior (no pisa personalizaciones).
 * El cliente deberá re-vincular su WhatsApp con el nuevo número.
 */
export async function updateClient(companyId: string, input: UpdateClientInput) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: CLIENT_INCLUDE,
  });
  if (!company) throw new AppError("Cliente no encontrado", 404);

  const adminUser =
    company.users.find((u) => u.role === "ADMIN") ?? company.users[0] ?? null;
  if (!adminUser) throw new AppError("El cliente no tiene un usuario administrador", 409);

  const oldPhone = adminUser.phone;
  const phoneChanged = Boolean(input.adminPhone && input.adminPhone !== oldPhone);

  // Unicidad de celular y usuario (excluyendo al propio admin).
  if (phoneChanged) {
    const clash = await prisma.user.findUnique({ where: { phone: input.adminPhone! } });
    if (clash && clash.id !== adminUser.id) {
      throw new AppError("Ya existe un usuario con ese celular", 409);
    }
  }
  if (input.username) {
    const uname = normalizeUsername(input.username);
    const clash = await prisma.user.findUnique({ where: { username: uname } });
    if (clash && clash.id !== adminUser.id) {
      throw new AppError("Ese usuario ya está en uso", 409);
    }
  }

  const passwordHash = input.newPassword ? await bcrypt.hash(input.newPassword, 10) : undefined;

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({
      where: { id: adminUser.id },
      data: {
        ...(input.adminName !== undefined ? { name: input.adminName } : {}),
        ...(input.adminEmail !== undefined ? { email: input.adminEmail } : {}),
        ...(input.username !== undefined
          ? { username: input.username ? normalizeUsername(input.username) : null }
          : {}),
        ...(input.adminPhone !== undefined ? { phone: input.adminPhone } : {}),
        ...(passwordHash ? { passwordHash } : {}),
      },
    });

    await tx.company.update({
      where: { id: companyId },
      data: {
        ...(input.companyName !== undefined ? { name: input.companyName } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(phoneChanged ? { adminPhone: input.adminPhone } : {}),
      },
    });

    // Seguir el número en la notificación de pagos solo si apuntaba al anterior.
    if (phoneChanged) {
      await tx.paymentConfig.updateMany({
        where: { companyId, notificationPhone: oldPhone },
        data: { notificationPhone: input.adminPhone! },
      });
    }

    return tx.company.findUniqueOrThrow({ where: { id: companyId }, include: CLIENT_INCLUDE });
  });

  return { ...mapClient(updated), phoneChanged };
}

export async function deleteClient(companyId: string) {
  console.log("[deleteClient] start", { companyId });

  const existing = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true },
  });

  if (!existing) {
    console.warn("[deleteClient] company not found", { companyId });
    throw new AppError("Cliente no encontrado", 404);
  }

  console.log("[deleteClient] company found", { name: existing.name });

  const whatsappConfig = await prisma.whatsappConfig.findUnique({
    where: { companyId },
    select: { smsToolsUserId: true },
  });

  console.log("[deleteClient] whatsappConfig", { smsToolsUserId: whatsappConfig?.smsToolsUserId ?? null });

  if (whatsappConfig?.smsToolsUserId) {
    try {
      console.log("[deleteClient] deleting SMS Tools user", { smsToolsUserId: whatsappConfig.smsToolsUserId });
      const result = await smsToolsAdmin.deleteUser(whatsappConfig.smsToolsUserId);
      console.log("[deleteClient] SMS Tools delete result", result);
    } catch (err) {
      console.warn("[deleteClient] SMS Tools delete failed (ignored)", err instanceof Error ? err.message : err);
    }
  } else {
    console.log("[deleteClient] no SMS Tools user to delete");
  }

  console.log("[deleteClient] deleting company from DB", { companyId });
  await prisma.company.delete({ where: { id: companyId } });
  console.log("[deleteClient] done");
}

export async function impersonateClientAdmin(superadminId: string, companyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, slug: true, isActive: true },
  });

  if (!company) {
    throw new AppError("Cliente no encontrado", 404);
  }

  const adminUser = await prisma.user.findFirst({
    where: {
      companyId,
      role: "ADMIN",
      isActive: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!adminUser) {
    throw new AppError("Esta empresa no tiene un admin activo para impersonar", 404);
  }

  const accessToken = signAccessToken(
    {
      sub: adminUser.id,
      companyId: adminUser.companyId,
      role: adminUser.role,
      impersonatedBy: superadminId,
    },
    { expiresIn: "1h" },
  );

  return {
    accessToken,
    user: {
      id: adminUser.id,
      name: adminUser.name,
      phone: adminUser.phone,
      companyId: adminUser.companyId,
      role: adminUser.role,
    },
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
    },
  };
}
