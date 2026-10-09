/**
 * Entrega del producto digital POR CORREO, a pedido del cliente.
 *
 * Reglas (deterministas, el modelo no decide ninguna):
 *  - Solo con un PaymentReceipt APROBADO del mismo cliente/empresa.
 *  - Solo productos DIGITALES en modo STATIC con emailEnabled.
 *  - Correo validado en código; se guarda en Customer.email.
 *  - Límites: 3 envíos por comprobante en 24 h; mismo correo+productos en 10 min = ya enviado.
 *  - Adjuntos: archivos con sendByEmail, leídos por storagePath (nunca por URL) y
 *    acotados a la carpeta de la empresa; si superan el tope, van como links.
 *  - Remitente: dirección de la plataforma (MAIL_FROM) con el nombre del negocio.
 * El registro queda en receipt.metadata.emailDeliveries (auditoría y límites).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { normalizeEmail, maskEmail } from "../../lib/email";
import { resolveOwnUpload, readUpload, storagePathFromUrl } from "../../lib/uploads";
import { signDownloadToken } from "../../lib/jwt";
import { normalizeFollowups } from "../../lib/product";
import { applySpintax } from "./reminder-templates";
import { digitalDeliveryEmail, type DeliveryEmailSection } from "./delivery.emails";
import { notifyOwner } from "./conversation.service";

const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;
const MAX_SENDS_PER_RECEIPT_24H = 3;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export type EmailDeliveryErrorCode =
  | "INVALID_EMAIL"
  | "NO_RECEIPT"
  | "NOT_APPROVED"
  | "NO_ELIGIBLE"
  | "MAIL_DISABLED"
  | "LIMIT"
  | "ALREADY_SENT"
  | "SEND_FAILED";

export class EmailDeliveryError extends Error {
  constructor(public code: EmailDeliveryErrorCode, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface EmailDeliveryRecord {
  email: string;
  productIds: string[];
  at: string;
  trigger: "agent" | "panel" | "web";
  attachments: number;
  byLinks: boolean;
  /** Mensajes adicionales incluidos en el correo. */
  followups?: number;
}

export interface SendDigitalDeliveryEmailInput {
  companyId: string;
  customerId: string;
  /** Comprobante concreto; si se omite, se usa el último APROBADO del cliente. */
  receiptId?: string | null;
  email: string;
  trigger: "agent" | "panel" | "web";
}

export interface SendDigitalDeliveryEmailResult {
  email: string;
  receiptId: string;
  products: string[];
  skippedProducts: string[];
  attachments: number;
  byLinks: boolean;
}

function readRecords(metadata: Prisma.JsonValue | null): EmailDeliveryRecord[] {
  const m = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  return Array.isArray(m.emailDeliveries) ? (m.emailDeliveries as EmailDeliveryRecord[]) : [];
}

/** Productos elegibles para entrega por correo dentro de un comprobante (o del último aprobado). */
export async function findEmailDeliverableReceipt(companyId: string, customerId: string, receiptId?: string | null) {
  const receipt = receiptId
    ? await prisma.paymentReceipt.findFirst({ where: { id: receiptId, companyId } })
    : await prisma.paymentReceipt.findFirst({
        where: { companyId, customerId, status: "APROBADO" },
        orderBy: { validatedAt: "desc" },
      });
  if (!receipt) throw new EmailDeliveryError("NO_RECEIPT", "No hay un pago aprobado para este cliente.");
  if (receipt.status !== "APROBADO") throw new EmailDeliveryError("NOT_APPROVED", "El pago aún no está aprobado.");
  if (receipt.customerId && receipt.customerId !== customerId) {
    throw new EmailDeliveryError("NO_RECEIPT", "El comprobante no pertenece a este cliente.");
  }
  const ids = receipt.productIds?.length ? receipt.productIds : receipt.productId ? [receipt.productId] : [];
  const products = ids.length
    ? await prisma.product.findMany({
        where: { id: { in: ids }, companyId },
        include: { digitalDelivery: true, files: { orderBy: { sortOrder: "asc" } } },
      })
    : [];
  const eligible = products.filter(
    (p) =>
      p.productType === "DIGITAL" &&
      p.digitalDelivery &&
      p.digitalDelivery.assignmentMode === "STATIC" &&
      p.digitalDelivery.emailEnabled &&
      (p.digitalDelivery.emailBody?.trim() || p.digitalDelivery.instructions?.trim()),
  );
  const skipped = products.filter((p) => !eligible.includes(p)).map((p) => p.name);
  return { receipt, eligible, skipped };
}

export async function sendDigitalDeliveryEmail(input: SendDigitalDeliveryEmailInput): Promise<SendDigitalDeliveryEmailResult> {
  const email = normalizeEmail(input.email);
  if (!email) throw new EmailDeliveryError("INVALID_EMAIL", "El correo no tiene un formato válido.");
  if (!mailerEnabled()) throw new EmailDeliveryError("MAIL_DISABLED", "El envío de correos no está disponible.");

  const { receipt, eligible, skipped } = await findEmailDeliverableReceipt(input.companyId, input.customerId, input.receiptId);
  if (!eligible.length) {
    throw new EmailDeliveryError("NO_ELIGIBLE", "Ninguno de los productos pagados tiene entrega por correo habilitada.", {
      skippedProducts: skipped,
    });
  }

  // Límites por comprobante (memoria en metadata: no depende del historial del chat).
  const records = readRecords(receipt.metadata);
  const now = Date.now();
  const productIds = eligible.map((p) => p.id).sort();
  const recent24h = records.filter((r) => now - Date.parse(r.at) < 24 * 60 * 60 * 1000);
  const dup = records.find(
    (r) => r.email === email && now - Date.parse(r.at) < DEDUPE_WINDOW_MS && [...r.productIds].sort().join(",") === productIds.join(","),
  );
  if (dup) throw new EmailDeliveryError("ALREADY_SENT", "Ese acceso ya se envió a ese correo hace un momento.", { at: dup.at });
  if (recent24h.length >= MAX_SENDS_PER_RECEIPT_24H) {
    throw new EmailDeliveryError("LIMIT", "Se alcanzó el máximo de envíos por correo para esta compra (3 en 24 h).");
  }

  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: input.companyId }, select: { name: true } }),
    prisma.customer.findFirst({ where: { id: input.customerId, companyId: input.companyId }, select: { name: true } }),
  ]);
  const companyName = company?.name ?? "Tu negocio";

  // Adjuntos: multimedia de los mensajes adicionales + archivos marcados, siempre de la
  // carpeta de ESTA empresa y hasta el tope total; lo que no cabe (o es externo) va como link.
  const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> = [];
  const attachedUrls = new Set<string>();
  let attachedBytes = 0;
  let byLinks = false;
  let followupCount = 0;
  const sections: DeliveryEmailSection[] = [];
  for (const p of eligible) {
    const dd = p.digitalDelivery!;
    const links: DeliveryEmailSection["links"] = [];
    const attachOrLink = async (url: string, storagePath: string | null, name: string, mimeType?: string) => {
      if (attachedUrls.has(url)) return;
      const resolved = storagePath ? await resolveOwnUpload(storagePath, { companyId: input.companyId }) : null;
      if (resolved && attachedBytes + resolved.size <= MAX_ATTACHMENTS_BYTES) {
        attachments.push({ filename: name || resolved.fileName, content: await readUpload(resolved), contentType: mimeType || undefined });
        attachedBytes += resolved.size;
        attachedUrls.add(url);
      } else {
        byLinks = true;
        links.push({ name: name || resolved?.fileName || url.split("/").pop() || "archivo", url });
      }
    };
    // Mensajes adicionales: mismo orden que en WhatsApp (texto → párrafo; media → adjunto/link).
    const extras: string[] = [];
    for (const f of normalizeFollowups(dd)) {
      followupCount += 1;
      if (f.message?.trim()) extras.push(f.message.trim());
      const url = f.mediaUrl?.trim();
      if (url) {
        const known = p.files.find((x) => x.url === url);
        await attachOrLink(url, known?.storagePath || storagePathFromUrl(url), known?.originalName || "", known?.mimeType);
      }
    }
    for (const f of p.files.filter((x) => x.sendByEmail || x.privateDownload)) {
      if (f.privateDownload) {
        // Archivo protegido: SIEMPRE como enlace firmado (7 días), nunca adjunto.
        const signed = `${f.url}?t=${encodeURIComponent(signDownloadToken({ companyId: input.companyId, fileId: f.id, ref: `receipt:${receipt.id}` }))}`;
        links.push({ name: f.originalName || f.description || "archivo", url: signed });
        byLinks = true;
        continue;
      }
      await attachOrLink(f.url, f.storagePath || null, f.originalName, f.mimeType);
    }
    sections.push({
      productName: p.name,
      bodyText: applySpintax((dd.emailBody?.trim() || dd.instructions).trim()),
      extras: extras.map(applySpintax),
      links,
    });
  }

  const subject =
    eligible.length === 1
      ? eligible[0].digitalDelivery!.emailSubject?.trim() || `Tu acceso a ${eligible[0].name} — ${companyName}`
      : `Tus accesos — ${companyName}`;
  const mail = digitalDeliveryEmail({ companyName, customerName: customer?.name, sections, attachmentCount: attachments.length });

  try {
    await sendMail({ to: email, fromName: `${companyName} vía FlowApp`, subject, html: mail.html, text: mail.text, attachments });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[email-delivery] fallo SMTP company=${input.companyId} receipt=${receipt.id} to=${maskEmail(email)}: ${msg}`);
    void notifyOwner(
      input.companyId,
      `⚠️ No pude enviar el acceso por correo a ${email} (${eligible.map((p) => p.name).join(", ")}). Revisa el chat del cliente: la entrega por WhatsApp sigue disponible.`,
    ).catch(() => undefined);
    throw new EmailDeliveryError("SEND_FAILED", "No se pudo enviar el correo en este momento.");
  }

  // Registro: correo del cliente + auditoría en el comprobante.
  const record: EmailDeliveryRecord = {
    email,
    productIds,
    at: new Date(now).toISOString(),
    trigger: input.trigger,
    attachments: attachments.length,
    byLinks,
    followups: followupCount,
  };
  const baseMeta = receipt.metadata && typeof receipt.metadata === "object" && !Array.isArray(receipt.metadata) ? (receipt.metadata as Record<string, unknown>) : {};
  await Promise.all([
    prisma.paymentReceipt.update({
      where: { id: receipt.id },
      data: { metadata: { ...baseMeta, emailDeliveries: [...records, record] } as unknown as Prisma.InputJsonValue },
    }),
    prisma.customer.updateMany({ where: { id: input.customerId, companyId: input.companyId }, data: { email } }),
  ]);
  console.log(
    `[email-delivery] enviado company=${input.companyId} receipt=${receipt.id} to=${maskEmail(email)} products=${eligible.length} followups=${followupCount} attachments=${attachments.length} byLinks=${byLinks} trigger=${input.trigger}`,
  );

  return {
    email,
    receiptId: receipt.id,
    products: eligible.map((p) => p.name),
    skippedProducts: skipped,
    attachments: attachments.length,
    byLinks,
  };
}
