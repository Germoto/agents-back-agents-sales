import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { validatePaymentInValidPay } from "../../lib/validpay-client";
import type { MatchBody, UpdateStatusBody, ClaimBody } from "./public-payments.schemas";

// -------------------------------------------------------------------------
// Helpers de identificación de company por phone admin (estilo /bot/config)
// -------------------------------------------------------------------------
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
      { code: "PHONE_NOT_AUTHORIZED" },
    );
  }
  return match.companyId;
}

// -------------------------------------------------------------------------
// Serializer
// -------------------------------------------------------------------------
function serializeReceipt(r: any) {
  return {
    id: r.id,
    companyId: r.companyId,
    source: r.source,
    externalId: r.externalId,
    // amountExpected se mantiene como mirror; amountPaid es el campo principal
    amountExpected: r.amountExpected,
    amountPaid: r.amountPaid ?? r.amountExpected,
    currency: r.currency ?? "PEN",
    status: r.status,
    payerName: r.payerName,
    paymentSource: r.paymentSource,
    payerPhone: r.payerPhone,
    operationCode: r.operationCode,
    reference: r.reference,
    occurredAt: r.occurredAt,
    validatedAt: r.validatedAt,
    validationMode: r.validationMode,
    matchScore: r.matchScore,
    matchStrategy: r.matchStrategy,
    matchedPayerNameInput: r.matchedPayerNameInput,
    validationNote: r.validationNote,
    rejectionReason: r.rejectionReason,
    customerId: r.customerId,
    productId: r.productId,
    productIds: r.productIds ?? [],
    orderId: r.orderId,
    metadata: r.metadata ?? null,
    claimedBy: r.claimedBy,
    claimedUntil: r.claimedUntil,
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

const RECEIPT_INCLUDE = {
  customer: { select: { id: true, phone: true, name: true } },
  product: { select: { id: true, slug: true, name: true } },
} as const;

// -------------------------------------------------------------------------
// Filtros utilitarios
// -------------------------------------------------------------------------
function normalizeAmount(value: string | number): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return num.toFixed(2);
}

function buildAmountFilter(value: string | number | undefined) {
  if (value === undefined || value === null || value === "") return {};
  const normalized = normalizeAmount(value);
  // Buscamos coincidencia en amountPaid o, para registros viejos, en amountExpected
  return {
    OR: [{ amountPaid: normalized }, { amountExpected: normalized }],
  } as Prisma.PaymentReceiptWhereInput;
}

interface ListPendingOpts {
  limit?: number;
  since?: string;
  source?: string;
  amountPaid?: string | number;
  payerName?: string;
  occurredFrom?: string;
  occurredTo?: string;
  paymentSource?: string;
  status?: "PENDIENTE" | "EN_REVISION" | "APROBADO" | "RECHAZADO";
}

export async function listPendingPayments(companyId: string, opts: ListPendingOpts) {
  const where: Prisma.PaymentReceiptWhereInput = {
    companyId,
    status: opts.status ?? "PENDIENTE",
  };

  if (opts.source) where.source = opts.source;
  if (opts.since) where.createdAt = { gte: new Date(opts.since) };

  const occurred: Prisma.DateTimeFilter = {};
  if (opts.occurredFrom) occurred.gte = new Date(opts.occurredFrom);
  if (opts.occurredTo) occurred.lte = new Date(opts.occurredTo);
  if (Object.keys(occurred).length) where.occurredAt = occurred;

  if (opts.paymentSource) {
    where.paymentSource = { equals: opts.paymentSource.toUpperCase(), mode: "insensitive" };
  }

  if (opts.payerName) {
    where.payerName = { contains: opts.payerName, mode: "insensitive" };
  }

  // amountPaid puede venir como mirror en amountExpected (registros viejos)
  const amountFilter = buildAmountFilter(opts.amountPaid);
  if ((amountFilter as any).OR) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), amountFilter];
  }

  const receipts = await prisma.paymentReceipt.findMany({
    where,
    include: RECEIPT_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
  });
  return receipts.map(serializeReceipt);
}

export async function getPaymentById(companyId: string, id: string) {
  const r = await prisma.paymentReceipt.findFirst({
    where: { id, companyId },
    include: RECEIPT_INCLUDE,
  });
  if (!r) throw new AppError("Comprobante no encontrado", 404, { code: "RECEIPT_NOT_FOUND" });
  return serializeReceipt(r);
}

// -------------------------------------------------------------------------
// POST /match : devuelve candidatos PENDIENTES con score
// -------------------------------------------------------------------------
function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1], dp[j]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Extrae el código de seguridad de un payerName tipo "Thalia Pei (cód: 934)". */
function extractCod(name: unknown): string | null {
  const m = String(name ?? "").match(/c[oó]d\.?\s*:?\s*(\d{2,6})/i);
  return m ? m[1] : null;
}

function nameSimilarity(input: string, target: string): "exact" | "similar" | "no" {
  const a = normalizeName(input);
  const b = normalizeName(target);
  if (!a || !b) return "no";
  if (a === b) return "exact";
  if (a.includes(b) || b.includes(a)) return "similar";
  // tokens en común
  const tokensA = new Set(a.split(" "));
  const tokensB = new Set(b.split(" "));
  let common = 0;
  for (const t of tokensA) if (tokensB.has(t) && t.length >= 3) common++;
  if (common >= 1) return "similar";
  // distancia relativa
  const maxLen = Math.max(a.length, b.length);
  const dist = levenshtein(a, b);
  if (maxLen > 0 && dist / maxLen <= 0.3) return "similar";
  return "no";
}

interface ScoredReceipt {
  receipt: any;
  matchScore: number;
  matchReasons: string[];
}

export async function matchPayments(companyId: string, body: MatchBody) {
  // Filtros de candidatos: traemos un superset y luego scoreamos en memoria
  const where: Prisma.PaymentReceiptWhereInput = {
    companyId,
    status: "PENDIENTE",
  };
  if (body.source) where.source = body.source;

  const occurred: Prisma.DateTimeFilter = {};
  if (body.occurredFrom) occurred.gte = new Date(body.occurredFrom);
  if (body.occurredTo) occurred.lte = new Date(body.occurredTo);
  if (Object.keys(occurred).length) where.occurredAt = occurred;

  // Si vino amountPaid lo usamos como filtro fuerte (rara vez hay match con monto distinto)
  const amountFilter = buildAmountFilter(body.amountPaid);
  if ((amountFilter as any).OR) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), amountFilter];
  }

  const candidates = await prisma.paymentReceipt.findMany({
    where,
    include: RECEIPT_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const scored: ScoredReceipt[] = candidates.map((r) => {
    const reasons: string[] = [];
    let score = 0;

    if (body.amountPaid !== undefined) {
      const target = normalizeAmount(body.amountPaid);
      const paid = r.amountPaid ?? r.amountExpected;
      if (paid && paid === target) {
        score += 50;
        reasons.push("amount_exact");
      }
    }

    if (body.payerName && r.payerName) {
      const sim = nameSimilarity(body.payerName, r.payerName);
      if (sim === "exact") {
        score += 30;
        reasons.push("payer_name_exact");
      } else if (sim === "similar") {
        score += 20;
        reasons.push("payer_name_similar");
      }
    }

    // CÓDIGO DE SEGURIDAD del comprobante (solo Yape→Yape): llave fuerte. ValidPay
    // lo reporta DENTRO del payerName con el formato "Nombre (cód: 934)". Se compara
    // el código leído del comprobante (vía visión) contra ese cód (extraído del
    // payerName) — y, por las dudas, contra operationCode/reference — con match
    // EXACTO (sin substrings, para no generar falsos positivos).
    const allCodes = [
      ...(body.operationCode ? [body.operationCode] : []),
      ...(body.operationCodes ?? []),
    ]
      .map((c) => String(c).replace(/\D/g, ""))
      .filter((c) => c.length >= 2);
    if (allCodes.length) {
      const targets = [extractCod(r.payerName), digitsOnly(r.operationCode), digitsOnly(r.reference)].filter(
        (t): t is string => !!t && t.length >= 2,
      );
      const hit = allCodes.some((code) => targets.some((t) => t === code));
      if (hit) {
        score += 60;
        reasons.push("operation_code_exact");
      }
    }

    if ((body.occurredFrom || body.occurredTo) && r.occurredAt) {
      const t = r.occurredAt.getTime();
      const fromOk = body.occurredFrom ? t >= new Date(body.occurredFrom).getTime() : true;
      const toOk = body.occurredTo ? t <= new Date(body.occurredTo).getTime() : true;
      if (fromOk && toOk) {
        score += 15;
        reasons.push("time_window");
      }
    }

    if (body.paymentSource && r.paymentSource) {
      if (r.paymentSource.toUpperCase() === body.paymentSource.toUpperCase()) {
        score += 5;
        reasons.push("payment_source_match");
      }
    }

    return { receipt: r, matchScore: score, matchReasons: reasons };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore || b.receipt.createdAt - a.receipt.createdAt);

  const limit = body.limit ?? 10;
  return scored.slice(0, limit).map((s) => ({
    ...serializeReceipt(s.receipt),
    matchScore: s.matchScore,
    matchReasons: s.matchReasons,
  }));
}

// -------------------------------------------------------------------------
// POST /:id/claim : lock con TTL
// -------------------------------------------------------------------------
const DEFAULT_CLAIM_TTL_SECONDS = 120;
const MAX_CLAIM_TTL_SECONDS = 600;

export async function claimPayment(companyId: string, id: string, body: ClaimBody) {
  const ttl = Math.min(body.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS, MAX_CLAIM_TTL_SECONDS);

  return prisma.$transaction(async (tx) => {
    const receipt = await tx.paymentReceipt.findFirst({ where: { id, companyId } });
    if (!receipt) throw new AppError("Comprobante no encontrado", 404, { code: "RECEIPT_NOT_FOUND" });

    const now = new Date();
    const claimExpired = receipt.claimedUntil ? receipt.claimedUntil.getTime() < now.getTime() : true;

    const claimable =
      receipt.status === "PENDIENTE" || (receipt.status === "EN_REVISION" && claimExpired);

    if (!claimable) {
      const code =
        receipt.status === "EN_REVISION"
          ? "CLAIM_HELD_BY_OTHER"
          : receipt.status === "APROBADO"
          ? "PAYMENT_ALREADY_APPROVED"
          : "PAYMENT_ALREADY_REJECTED";
      throw new AppError(
        receipt.status === "EN_REVISION"
          ? `Comprobante ya reclamado por '${receipt.claimedBy}' hasta ${receipt.claimedUntil?.toISOString()}`
          : `Comprobante en estado ${receipt.status}, no se puede reclamar`,
        409,
        { code },
      );
    }

    const claimedUntil = new Date(now.getTime() + ttl * 1000);

    const updated = await tx.paymentReceipt.update({
      where: { id: receipt.id },
      data: {
        status: "EN_REVISION",
        claimedBy: body.claimedBy,
        claimedUntil,
      },
      include: RECEIPT_INCLUDE,
    });

    const serialized = serializeReceipt(updated);
    socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_UPDATED, {
      id: serialized.id,
      status: serialized.status,
    });
    return serialized;
  });
}

// -------------------------------------------------------------------------
// PATCH /:id/status (extendido)
// -------------------------------------------------------------------------
function mergeMetadata(
  existing: Prisma.JsonValue | null | undefined,
  incoming: Record<string, any> | undefined,
  extras: Record<string, any> = {},
): Prisma.InputJsonValue | undefined {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, any>)
      : {};
  const merged = { ...base, ...(incoming ?? {}), ...extras };
  if (!Object.keys(merged).length) return undefined;
  return merged as Prisma.InputJsonValue;
}

export async function updatePaymentStatus(
  companyId: string,
  id: string,
  input: UpdateStatusBody,
) {
  const receipt = await prisma.paymentReceipt.findFirst({
    where: { id, companyId },
  });
  if (!receipt) throw new AppError("Comprobante no encontrado", 404);

  // Transición permitida
  // - APROBADO/RECHAZADO desde PENDIENTE o EN_REVISION (con TTL no expirado)
  // - EN_REVISION redirige a /claim conceptualmente; aquí lo bloqueamos para forzar uso del endpoint claim
  if (input.status === "EN_REVISION") {
    throw new AppError(
      "Para reclamar un comprobante usa POST /api/public/payments/:id/claim",
      400,
      { code: "USE_CLAIM_ENDPOINT" },
    );
  }

  if (receipt.status === "APROBADO") {
    throw new AppError(
      "El comprobante ya está APROBADO",
      409,
      { code: "PAYMENT_ALREADY_APPROVED" },
    );
  }
  if (receipt.status === "RECHAZADO") {
    throw new AppError(
      "El comprobante ya está RECHAZADO",
      409,
      { code: "PAYMENT_ALREADY_REJECTED" },
    );
  }

  if (receipt.status === "EN_REVISION") {
    const now = Date.now();
    if (receipt.claimedUntil && receipt.claimedUntil.getTime() < now) {
      throw new AppError(
        "El claim de este comprobante expiró. Vuelve a reclamarlo antes de cerrarlo.",
        409,
        { code: "CLAIM_EXPIRED" },
      );
    }
  }

  // -------- Validar productIds / productId --------
  const productIdsInput =
    input.productIds && input.productIds.length
      ? input.productIds
      : input.productId
      ? [input.productId]
      : [];

  let productIdsToSet: string[] | undefined;
  let productIdToSet: string | null | undefined;

  if (productIdsInput.length > 0) {
    const found = await prisma.product.findMany({
      where: {
        companyId,
        OR: [{ id: { in: productIdsInput } }, { slug: { in: productIdsInput } }],
      },
      select: { id: true, slug: true },
    });

    // Construir mapa raw (uuid o slug) -> uuid resuelto
    const resolvedMap = new Map<string, string>();
    for (const p of found) {
      resolvedMap.set(p.id, p.id);
      resolvedMap.set(p.slug, p.id);
    }

    const unresolved = productIdsInput.filter((raw) => !resolvedMap.has(raw));
    if (unresolved.length > 0) {
      throw new AppError(
        `Producto(s) no encontrado(s) para esta compañía: ${unresolved.join(", ")}`,
        404,
        {
          code: "PRODUCT_NOT_FOUND",
          errors: unresolved.map((v) => ({
            field: "productId",
            message: `'${v}' no pertenece a esta compañía o no existe`,
          })),
        },
      );
    }

    const resolvedIds = productIdsInput.map((raw) => resolvedMap.get(raw)!);
    productIdsToSet = resolvedIds;
    productIdToSet = resolvedIds[0];
  }

  // -------- Upsert customer por phone --------
  let customerIdToSet: string | null | undefined;
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

  // -------- Metadata merge --------
  const metadataExtras: Record<string, any> = {};
  if (input.expectedAmount !== undefined) {
    metadataExtras.expectedAmount = normalizeAmount(input.expectedAmount);
  }
  const mergedMetadata = mergeMetadata(receipt.metadata, input.metadata, metadataExtras);

  const rejectionInput = input.rejectionReason ?? input.reason ?? null;

  const updated = await prisma.paymentReceipt.update({
    where: { id: receipt.id },
    data: {
      status: input.status,
      rejectionReason: input.status === "RECHAZADO" ? rejectionInput : null,
      validationNote: input.note ?? null,
      validatedAt: new Date(),
      validationMode: input.validationMode ?? null,
      matchScore: input.matchScore ?? null,
      matchStrategy: input.matchStrategy ?? null,
      matchedPayerNameInput: input.matchedPayerNameInput ?? null,
      orderId: input.orderId ?? receipt.orderId ?? null,
      ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
      ...(customerIdToSet !== undefined ? { customerId: customerIdToSet } : {}),
      ...(productIdToSet !== undefined ? { productId: productIdToSet } : {}),
      ...(productIdsToSet !== undefined ? { productIds: productIdsToSet } : {}),
      // Liberar claim
      claimedBy: null,
      claimedUntil: null,
    },
    include: RECEIPT_INCLUDE,
  });

  // Solo notificar a ValidPay cuando se aprueba (RECHAZADO es estado interno de Sales Agents)
  if (input.status === "APROBADO" && updated.source === "validpay" && updated.externalId) {
    notifyValidPayApproval(companyId, updated.externalId).catch((err) => {
      console.error("[ValidPay] No se pudo notificar aprobación desde n8n:", err.message);
    });
  }

  const serialized = serializeReceipt(updated);
  socketService.emitToCompany(companyId, SOCKET_EVENTS.RECEIPT_UPDATED, {
    id: serialized.id,
    status: serialized.status,
  });
  return serialized;
}

async function notifyValidPayApproval(companyId: string, externalId: string): Promise<void> {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { companyId, source: "validpay", active: true, validpayApiKey: { not: null } },
    select: { validpayApiKey: true },
  });
  if (!endpoint?.validpayApiKey) return;
  await validatePaymentInValidPay(endpoint.validpayApiKey, externalId);
}
