import bcrypt from "bcrypt";
import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { signAccessToken } from "../../lib/jwt";

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

  const company = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
