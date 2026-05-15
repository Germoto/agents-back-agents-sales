import { prisma } from "../../lib/prisma";

type PaymentMode = "BEFORE_DELIVERY" | "CASH_ON_DELIVERY" | "MANUAL";

function mapPaymentConfig(config: {
  id: string;
  companyId: string;
  enabled: boolean;
  paymentMode: PaymentMode;
  notificationPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
  methods: Array<{
    id: string;
    method: string;
    number: string;
    holder: string;
    sortOrder: number;
  }>;
} | null) {
  if (!config) {
    return null;
  }

  return {
    ...config,
    methods: config.methods
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => ({
        id: item.id,
        method: item.method,
        number: item.number,
        holder: item.holder,
        sortOrder: item.sortOrder,
      })),
    notification: {
      whatsappPhone: config.notificationPhone,
    },
  };
}

export async function getPaymentConfig(companyId: string) {
  const config = await prisma.paymentConfig.findUnique({
    where: { companyId },
    include: {
      methods: {
        orderBy: { sortOrder: "asc" },
      },
    },
  });

  return mapPaymentConfig(config);
}

export async function upsertPaymentConfig(companyId: string, data: {
  enabled: boolean;
  notificationPhone: string;
  methods: Array<{
    method: string;
    number: string;
    holder: string;
    sortOrder: number;
  }>;
  paymentMode: PaymentMode;
}) {
  const config = await prisma.$transaction(async (tx) => {
    const paymentConfig = await tx.paymentConfig.upsert({
      where: { companyId },
      update: {
        enabled: data.enabled,
        paymentMode: data.paymentMode,
        notificationPhone: data.notificationPhone,
      },
      create: {
        enabled: data.enabled,
        paymentMode: data.paymentMode,
        notificationPhone: data.notificationPhone,
        company: {
          connect: { id: companyId },
        },
      },
    });

    await tx.paymentMethod.deleteMany({
      where: { paymentConfigId: paymentConfig.id },
    });

    await tx.paymentMethod.createMany({
      data: data.methods.map((item, index) => ({
        paymentConfigId: paymentConfig.id,
        method: item.method,
        number: item.number,
        holder: item.holder,
        sortOrder: item.sortOrder ?? index,
      })),
    });

    return tx.paymentConfig.findUniqueOrThrow({
      where: { id: paymentConfig.id },
      include: {
        methods: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });
  });

  return mapPaymentConfig(config);
}
