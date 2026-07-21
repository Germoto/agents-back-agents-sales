import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { encryptCredential, decryptCredential } from "../../lib/credentials-crypto";
import { mpGetMe } from "../../lib/mercadopago-client";

type PaymentMode = "BEFORE_DELIVERY" | "CASH_ON_DELIVERY" | "MANUAL";

function maskToken(token: string): string {
  if (token.length <= 10) return "•••";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/** Config de Mercado Pago para el panel (el token nunca viaja en claro). */
function mapMpConfig(config: {
  mpEnabled: boolean;
  mpAccessToken: string | null;
  mpFeeMode: string;
  mpFeePercent: unknown;
  mpFeeFixed: unknown;
  mpFeeIgv: boolean;
} | null) {
  if (!config) {
    return { enabled: false, connected: false, feeMode: "TENANT", feePercent: 3.99, feeFixed: 1, feeIgv: true };
  }
  const plain = config.mpAccessToken ? decryptCredential(config.mpAccessToken) : "";
  return {
    enabled: config.mpEnabled,
    connected: Boolean(plain),
    maskedToken: plain ? maskToken(plain) : undefined,
    feeMode: config.mpFeeMode,
    feePercent: Number(config.mpFeePercent),
    feeFixed: Number(config.mpFeeFixed),
    feeIgv: config.mpFeeIgv,
  };
}

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

  const mapped = mapPaymentConfig(config);
  return mapped ? { ...mapped, mp: mapMpConfig(config) } : { mp: mapMpConfig(null) };
}

/**
 * Config de Mercado Pago: token (cifrado; se valida contra la API al guardarlo)
 * + quién asume la comisión y sus parámetros. accessToken vacío = no cambiar;
 * null = desconectar.
 */
export async function updateMercadoPagoConfig(
  companyId: string,
  data: {
    accessToken?: string | null;
    enabled: boolean;
    feeMode: "TENANT" | "CUSTOMER";
    feePercent: number;
    feeFixed: number;
    feeIgv: boolean;
  },
) {
  let account: { nickname: string; email?: string } | null = null;
  const update: Record<string, unknown> = {
    mpEnabled: data.enabled,
    mpFeeMode: data.feeMode,
    mpFeePercent: data.feePercent,
    mpFeeFixed: data.feeFixed,
    mpFeeIgv: data.feeIgv,
  };

  if (data.accessToken === null) {
    update.mpAccessToken = null;
    update.mpEnabled = false;
  } else if (data.accessToken && data.accessToken.trim()) {
    const token = data.accessToken.trim();
    try {
      const me = await mpGetMe(token);
      account = { nickname: me.nickname, email: me.email };
    } catch (err) {
      throw new AppError(
        `El Access Token no es válido: ${err instanceof Error ? err.message : "error de Mercado Pago"}`,
        400,
      );
    }
    update.mpAccessToken = encryptCredential(token);
  }

  const config = await prisma.paymentConfig.upsert({
    where: { companyId },
    update,
    // Si el tenant aún no configuró pagos, se crea el registro con defaults.
    create: {
      companyId,
      enabled: true,
      paymentMode: "BEFORE_DELIVERY",
      ...update,
    },
  });

  return { mp: mapMpConfig(config), account };
}

/** Probar conexión con el token guardado. */
export async function testMercadoPagoConnection(companyId: string) {
  const config = await prisma.paymentConfig.findUnique({ where: { companyId } });
  const plain = config?.mpAccessToken ? decryptCredential(config.mpAccessToken) : "";
  if (!plain) throw new AppError("No hay un Access Token de Mercado Pago guardado", 400);
  try {
    const me = await mpGetMe(plain);
    return { ok: true, account: { nickname: me.nickname, email: me.email } };
  } catch (err) {
    throw new AppError(
      `No se pudo conectar con Mercado Pago: ${err instanceof Error ? err.message : "error"}`,
      400,
    );
  }
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
