import bcrypt from "bcrypt";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { signAccessToken } from "../../lib/jwt";
import { smsToolsAdmin, DEFAULT_API_KEY_PERMISSIONS } from "../../lib/smstools-admin-client";
import { env } from "../../config/env";

function defaultRules() {
  return [
    "Responde en español.",
    "No inventes stock ni promociones.",
    "Pide datos de entrega solo cuando el cliente confirme compra.",
  ];
}

function mapClient(company: {
  id: string;
  name: string;
  slug: string;
  adminPhone: string;
  timezone: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  users: Array<{
    id: string;
    name: string;
    phone: string;
    role: UserRole;
    isActive: boolean;
    createdAt: Date;
  }>;
} & {
  _count?: {
    products: number;
  };
}) {
  const adminUser =
    company.users.find((user) => user.role === "ADMIN") ??
    company.users.find((user) => user.role === "SUPERADMIN") ??
    company.users[0] ??
    null;

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
          role: adminUser.role,
          isActive: adminUser.isActive,
          createdAt: adminUser.createdAt,
        }
      : null,
    productCount: company._count?.products ?? 0,
  };
}

export async function loginSuperadmin(phone: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { phone },
    include: { company: true },
  });

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
    include: {
      users: {
        where: {
          role: {
            in: ["ADMIN", "SUPERADMIN"],
          },
        },
        orderBy: { createdAt: "asc" },
      },
      _count: {
        select: {
          products: true,
        },
      },
    },
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
}) {
  const existingCompany = await prisma.company.findUnique({
    where: { slug: payload.slug },
    select: { id: true },
  });

  if (existingCompany) {
    throw new AppError("Ya existe un cliente con ese slug", 409);
  }

  const existingUser = await prisma.user.findUnique({
    where: { phone: payload.adminPhone },
    select: { id: true },
  });

  if (existingUser) {
    throw new AppError("Ya existe un usuario con ese celular", 409);
  }

  const passwordHash = await bcrypt.hash(payload.password, 10);

  // 1) Provision the SMS TOOLS account + API key BEFORE we touch the DB
  //    so we can fail fast without leaving orphan records.
  let smsToolsUserId: number | null = null;
  let smsToolsSecret: string | null = null;
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

    await tx.whatsappConfig.create({
      data: {
        companyId: createdCompany.id,
        apiUrl: env.SMSTOOLS_API_URL,
        secret: smsToolsSecret!,
        smsToolsUserId: smsToolsUserId,
        isActive: payload.isActive,
      },
    });

    return tx.company.findUniqueOrThrow({
      where: { id: createdCompany.id },
      include: {
        users: {
          where: {
            role: {
              in: ["ADMIN", "SUPERADMIN"],
            },
          },
          orderBy: { createdAt: "asc" },
        },
        _count: {
          select: {
            products: true,
          },
        },
      },
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
      include: {
        users: {
          where: {
            role: {
              in: ["ADMIN", "SUPERADMIN"],
            },
          },
          orderBy: { createdAt: "asc" },
        },
        _count: {
          select: {
            products: true,
          },
        },
      },
    });
  });

  return mapClient(company);
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
