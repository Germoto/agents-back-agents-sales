import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

function phoneMatches(source: string, incoming: string) {
  const sourceDigits = normalizePhone(source);
  const incomingDigits = normalizePhone(incoming);
  if (!sourceDigits || !incomingDigits) return false;
  return (
    sourceDigits === incomingDigits ||
    sourceDigits.endsWith(incomingDigits) ||
    incomingDigits.endsWith(sourceDigits)
  );
}

/**
 * Resuelve companyId a partir del teléfono de un usuario admin activo.
 * Mismo patrón que /api/bot/config.
 */
export async function resolveCompanyIdByPhone(phone: string): Promise<string> {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { companyId: true, phone: true },
  });
  const match = users.find((u) => phoneMatches(u.phone, phone));
  if (!match) {
    throw new AppError(
      "El numero indicado no pertenece a un usuario activo con acceso a la API publica de pagos",
      403,
    );
  }
  return match.companyId;
}

function serializeReceipt(r: any) {
  return {
    id: r.id,
    companyId: r.companyId,
    source: r.source,
    externalId: r.externalId,
    amountExpected: r.amountExpected,
    status: r.status,
    payerName: r.payerName,
    paymentSource: r.paymentSource,
    occurredAt: r.occurredAt,
    validatedAt: r.validatedAt,
    validationNote: r.validationNote,
    rejectionReason: r.rejectionReason,
    customerId: r.customerId,
    productId: r.productId,
    customer: r.customer
      ? { id: r.customer.id, phone: r.customer.phone, name: r.customer.name }
      : null,
    product: r.product
      ? { id: r.product.id, slug: r.product.slug, name: r.product.name }
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function listPendingPayments(
  companyId: string,
  opts: { limit?: number; since?: string; source?: string },
) {
  const receipts = await prisma.paymentReceipt.findMany({
    where: {
      companyId,
      status: "PENDIENTE",
      ...(opts.source ? { source: opts.source } : {}),
      ...(opts.since ? { createdAt: { gte: new Date(opts.since) } } : {}),
    },
    include: {
      customer: { select: { id: true, phone: true, name: true } },
      product: { select: { id: true, slug: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
  });
  return receipts.map(serializeReceipt);
}

export async function getPaymentById(companyId: string, id: string) {
  const r = await prisma.paymentReceipt.findFirst({
    where: { id, companyId },
    include: {
      customer: { select: { id: true, phone: true, name: true } },
      product: { select: { id: true, slug: true, name: true } },
    },
  });
  if (!r) throw new AppError("Comprobante no encontrado", 404);
  return serializeReceipt(r);
}

interface UpdateStatusInput {
  status: "APROBADO" | "RECHAZADO";
  reason?: string;
  customerPhone?: string;
  customerName?: string;
  productId?: string;
  note?: string;
}

/**
 * Aprueba o rechaza un comprobante. n8n puede enviar customerPhone/productId
 * para asociar el comprobante huérfano al cliente/producto correspondiente.
 */
export async function updatePaymentStatus(
  companyId: string,
  id: string,
  input: UpdateStatusInput,
) {
  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id, companyId },
  });
  if (!receipt) throw new AppError("Comprobante no encontrado", 404);
  if (receipt.status !== "PENDIENTE") {
    throw new AppError(
      `El comprobante ya está en estado ${receipt.status}. Solo se puede actualizar uno PENDIENTE.`,
      409,
    );
  }

  // Validar productId si vino
  let productIdToSet: string | null | undefined = undefined;
  if (input.productId) {
    const product = await prisma.product.findFirst({
      where: { id: input.productId, companyId },
      select: { id: true },
    });
    if (!product) throw new AppError("productId no pertenece a esta compañía", 422);
    productIdToSet = product.id;
  }

  // Upsert de customer por phone si vino
  let customerIdToSet: string | null | undefined = undefined;
  if (input.customerPhone) {
    const phoneNorm = input.customerPhone.startsWith("+")
      ? input.customerPhone
      : `+${input.customerPhone.replace(/\D/g, "")}`;

    const existing = await prisma.customer.findFirst({
      where: { companyId, phone: phoneNorm },
      select: { id: true },
    });

    if (existing) {
      customerIdToSet = existing.id;
      if (input.customerName) {
        await prisma.customer.update({
          where: { id: existing.id },
          data: { name: input.customerName, lastInteractionAt: new Date() },
        });
      }
    } else {
      const created = await prisma.customer.create({
        data: {
          companyId,
          phone: phoneNorm,
          name: input.customerName || "Cliente ValidPay",
          status: "activo",
          lastInteractionAt: new Date(),
          metadata: { origin: "n8n-public-api" },
        },
        select: { id: true },
      });
      customerIdToSet = created.id;
    }
  }

  const updated = await prisma.paymentReceipt.update({
    where: { id: receipt.id },
    data: {
      status: input.status,
      rejectionReason: input.status === "RECHAZADO" ? input.reason ?? null : null,
      validationNote: input.note ?? null,
      validatedAt: new Date(),
      ...(customerIdToSet !== undefined ? { customerId: customerIdToSet } : {}),
      ...(productIdToSet !== undefined ? { productId: productIdToSet } : {}),
    },
    include: {
      customer: { select: { id: true, phone: true, name: true } },
      product: { select: { id: true, slug: true, name: true } },
    },
  });

  return serializeReceipt(updated);
}
