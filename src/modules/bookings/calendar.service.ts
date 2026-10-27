/**
 * Calendario de citas (fase 1, sin OAuth):
 *  - ICS por cita + enlace a Google Calendar para que el CLIENTE agregue la cita
 *    a su calendario (iPhone/Android/Outlook) desde un link corto público.
 *  - Feed ICS secreto por empresa con TODAS las citas y bloqueos, para que el
 *    DUEÑO lo suscriba en iPhone / Google Calendar / Outlook (un solo sentido).
 *  - Invitación por correo (METHOD:REQUEST / CANCEL) cuando el cliente tiene email.
 *
 * Todo se genera a mano (RFC 5545 básico: CRLF, folding a 75 octetos, escape),
 * sin dependencias nuevas.
 */

import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { isValidEmail } from "../../lib/email";
import { formatSlotLabel } from "./availability.service";

// ---------------------------------------------------------------------------
// Tipos mínimos (lo que necesita el generador; cualquier include compatible sirve)
// ---------------------------------------------------------------------------
export interface CalendarBooking {
  id: string;
  bookingCode: string | null;
  cancelToken: string | null;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  durationMin: number | null;
  modality: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  customer?: { name: string | null; phone: string; email?: string | null } | null;
  product?: { name: string; verticalData?: unknown } | null;
}

export interface CalendarCompany {
  name: string;
  timezone: string;
}

export interface CalendarLinks {
  google: string;
  ics: string;
}

const PRODID = "-//FlowApp//Citas//ES";
const UID_DOMAIN = "flowapp.pe";
const DEFAULT_DURATION_MIN = 60;

// ---------------------------------------------------------------------------
// Helpers ICS
// ---------------------------------------------------------------------------
function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Escapa texto para propiedades ICS (RFC 5545 §3.3.11). */
export function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folding a 75 octetos: líneas largas continúan con CRLF + espacio. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    const max = first ? 75 : 74;
    let end = Math.min(start + max, bytes.length);
    // No cortar en medio de un carácter UTF-8 multibyte.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return out.join("\r\n");
}

function calendar(lines: string[], extra: { method?: string; name?: string; timezone?: string } = {}): string {
  const head = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    ...(extra.method ? [`METHOD:${extra.method}`] : []),
    ...(extra.name ? [`X-WR-CALNAME:${icsEscape(extra.name)}`] : []),
    ...(extra.timezone ? [`X-WR-TIMEZONE:${extra.timezone}`] : []),
    ...(extra.name ? ["X-PUBLISHED-TTL:PT1H"] : []),
  ];
  return [...head, ...lines, "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";
}

function bookingEnd(b: CalendarBooking): Date | null {
  if (!b.startsAt) return null;
  if (b.endsAt) return b.endsAt;
  return new Date(b.startsAt.getTime() + (b.durationMin ?? DEFAULT_DURATION_MIN) * 60_000);
}

function locationOf(b: CalendarBooking): string {
  const v = (b.product?.verticalData ?? null) as Record<string, unknown> | null;
  const loc = v && (typeof v.location === "string" ? v.location : typeof v.address === "string" ? v.address : "");
  return (loc ?? "").trim();
}

function summaryOf(b: CalendarBooking, company: CalendarCompany): string {
  return `${b.product?.name ?? "Cita"} · ${company.name}`;
}

function descriptionOf(b: CalendarBooking, company: CalendarCompany): string {
  const parts = [
    b.bookingCode ? `Código de cita: ${b.bookingCode}` : "",
    b.modality ? `Modalidad: ${b.modality}` : "",
    b.notes ? `Notas: ${b.notes}` : "",
    `Agendado por WhatsApp con ${company.name}.`,
  ].filter(Boolean);
  return parts.join("\n");
}

/** SEQUENCE creciente simple: segundos entre creación y última modificación. */
export function sequenceOf(b: CalendarBooking): number {
  const diff = Math.floor((b.updatedAt.getTime() - b.createdAt.getTime()) / 1000);
  return diff > 0 ? diff : 0;
}

function bookingEvent(b: CalendarBooking, company: CalendarCompany, opts: { sequence?: number; organizerName?: string } = {}): string[] {
  const start = b.startsAt;
  const end = bookingEnd(b);
  if (!start || !end) return [];
  const cancelled = b.status === "CANCELADA";
  const uid = `${b.bookingCode ?? b.id}@${UID_DOMAIN}`;
  const location = locationOf(b);
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(cancelled ? `[Cancelada] ${summaryOf(b, company)}` : summaryOf(b, company))}`,
    `DESCRIPTION:${icsEscape(descriptionOf(b, company))}`,
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    `SEQUENCE:${opts.sequence ?? sequenceOf(b)}`,
    ...(opts.organizerName ? [`ORGANIZER;CN=${icsEscape(opts.organizerName)}:mailto:${mailFrom()}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Recordatorio de cita",
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
  ];
}

function mailFrom(): string {
  const raw = env.MAIL_FROM || env.SMTP_USER || "citas@flowapp.pe";
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

// ---------------------------------------------------------------------------
// API pública del módulo
// ---------------------------------------------------------------------------

/** ICS de UNA cita (descarga para el cliente o invitación por correo). */
export function bookingIcs(
  b: CalendarBooking,
  company: CalendarCompany,
  opts: { method?: "PUBLISH" | "REQUEST" | "CANCEL"; sequence?: number } = {},
): string {
  const method = opts.method ?? "PUBLISH";
  return calendar(bookingEvent(b, company, { sequence: opts.sequence, organizerName: method === "PUBLISH" ? undefined : company.name }), { method });
}

/** Feed ICS de la empresa: citas (confirmadas, completadas y canceladas recientes) + bloqueos. */
export function companyFeedIcs(
  company: CalendarCompany,
  bookings: CalendarBooking[],
  blocks: Array<{ id: string; startsAt: Date; endsAt: Date; reason: string | null }>,
): string {
  const lines: string[] = [];
  for (const b of bookings) lines.push(...bookingEvent(b, company));
  for (const bl of blocks) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:block-${bl.id}@${UID_DOMAIN}`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(bl.startsAt)}`,
      `DTEND:${icsDate(bl.endsAt)}`,
      `SUMMARY:${icsEscape(`🚫 Bloqueo${bl.reason ? `: ${bl.reason}` : ""}`)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }
  return calendar(lines, { name: `Citas · ${company.name}`, timezone: company.timezone });
}

/** URL de Google Calendar con el evento prellenado (no requiere OAuth). */
export function googleCalendarUrl(b: CalendarBooking, company: CalendarCompany): string {
  const start = b.startsAt;
  const end = bookingEnd(b);
  if (!start || !end) return "https://calendar.google.com/calendar/";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: summaryOf(b, company),
    dates: `${icsDate(start)}/${icsDate(end)}`,
    details: descriptionOf(b, company),
    ctz: company.timezone || "America/Lima",
  });
  const location = locationOf(b);
  if (location) params.set("location", location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Enlaces cortos públicos de una cita (firmados con su cancelToken). */
export function bookingCalendarLinks(b: Pick<CalendarBooking, "bookingCode" | "cancelToken" | "startsAt">): CalendarLinks | null {
  if (!b.bookingCode || !b.cancelToken || !b.startsAt) return null;
  const base = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/public/calendar/cita/${encodeURIComponent(b.bookingCode)}`;
  const t = encodeURIComponent(b.cancelToken);
  return { google: `${base}/google?t=${t}`, ics: `${base}.ics?t=${t}` };
}

/** Mensaje fijo que recibe el cliente tras confirmar la cita. */
export function calendarLinksMessage(links: CalendarLinks): string {
  return `📅 Agrega la cita a tu calendario:\nGoogle: ${links.google}\niPhone / otros: ${links.ics}`;
}

const calendarInclude = {
  customer: { select: { name: true, phone: true, email: true } },
  product: { select: { name: true, verticalData: true } },
  company: { select: { name: true, timezone: true } },
} as const;

export async function loadBookingForCalendar(bookingId: string) {
  return prisma.serviceBooking.findUnique({ where: { id: bookingId }, include: calendarInclude });
}

/** Cita por código público + token (para las rutas /public/calendar/cita/…). */
export async function loadPublicBooking(code: string, token: string) {
  if (!code || !token) return null;
  const b = await prisma.serviceBooking.findFirst({ where: { bookingCode: code }, include: calendarInclude });
  if (!b || !b.cancelToken || b.cancelToken !== token) return null;
  return b;
}

// ---------------------------------------------------------------------------
// Feed por empresa
// ---------------------------------------------------------------------------
export function newCalendarFeedToken(): string {
  return `cal_${crypto.randomBytes(24).toString("hex")}`;
}

export function calendarFeedUrl(token: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/public/calendar/feed/${token}.ics`;
}

export async function getOrCreateCalendarFeed(companyId: string): Promise<{ url: string; enabled: boolean }> {
  const existing = await prisma.companyCalendarFeed.findUnique({ where: { companyId } });
  const feed = existing ?? (await prisma.companyCalendarFeed.create({ data: { companyId, token: newCalendarFeedToken() } }));
  return { url: calendarFeedUrl(feed.token), enabled: feed.enabled };
}

export async function regenerateCalendarFeed(companyId: string): Promise<{ url: string; enabled: boolean }> {
  const feed = await prisma.companyCalendarFeed.upsert({
    where: { companyId },
    update: { token: newCalendarFeedToken() },
    create: { companyId, token: newCalendarFeedToken() },
  });
  return { url: calendarFeedUrl(feed.token), enabled: feed.enabled };
}

export async function setCalendarFeedEnabled(companyId: string, enabled: boolean): Promise<{ url: string; enabled: boolean }> {
  const feed = await prisma.companyCalendarFeed.upsert({
    where: { companyId },
    update: { enabled },
    create: { companyId, token: newCalendarFeedToken(), enabled },
  });
  return { url: calendarFeedUrl(feed.token), enabled: feed.enabled };
}

const FEED_PAST_DAYS = 30;
const FEED_FUTURE_DAYS = 180;

/** Genera el feed ICS de la empresa dueña del token (null si no existe o está apagado). */
export async function buildCompanyFeed(token: string): Promise<string | null> {
  if (!token) return null;
  const feed = await prisma.companyCalendarFeed.findUnique({
    where: { token },
    include: { company: { select: { id: true, name: true, timezone: true } } },
  });
  if (!feed || !feed.enabled) return null;
  const now = Date.now();
  const from = new Date(now - FEED_PAST_DAYS * 86_400_000);
  const to = new Date(now + FEED_FUTURE_DAYS * 86_400_000);
  const [bookings, blocks] = await Promise.all([
    prisma.serviceBooking.findMany({
      where: {
        companyId: feed.company.id,
        startsAt: { not: null, gte: from, lte: to },
        OR: [{ status: { in: ["CONFIRMADA", "COMPLETADA"] } }, { status: "CANCELADA", updatedAt: { gte: from } }],
      },
      include: { customer: { select: { name: true, phone: true, email: true } }, product: { select: { name: true, verticalData: true } } },
      orderBy: { startsAt: "asc" },
      take: 2000,
    }),
    prisma.scheduleBlock.findMany({
      where: { companyId: feed.company.id, endsAt: { gte: from }, startsAt: { lte: to } },
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    }),
  ]);
  const company = { name: feed.company.name, timezone: feed.company.timezone || "America/Lima" };
  // En el feed del dueño el título incluye al cliente.
  const withCustomer = bookings.map((b) => ({
    ...b,
    product: b.product ? { ...b.product, name: `${b.product.name} — ${b.customer?.name || b.customer?.phone || "cliente"}` } : b.product,
  }));
  return companyFeedIcs(company, withCustomer, blocks);
}

// ---------------------------------------------------------------------------
// Invitación por correo al cliente (best-effort)
// ---------------------------------------------------------------------------
export type BookingEventKind = "created" | "rescheduled" | "cancelled";

/**
 * Tras crear/reprogramar/cancelar una cita con hora: si el cliente tiene correo
 * y hay SMTP, le envía la invitación (.ics METHOD:REQUEST o CANCEL). Nunca lanza.
 * Devuelve los enlaces de calendario de la cita (null si no aplica).
 */
export async function afterBookingChanged(bookingId: string, kind: BookingEventKind): Promise<CalendarLinks | null> {
  try {
    const b = await loadBookingForCalendar(bookingId);
    if (!b || !b.startsAt) return null;
    const company = { name: b.company.name, timezone: b.company.timezone || "America/Lima" };
    const links = bookingCalendarLinks(b);
    const email = (b.customer?.email ?? "").trim();
    if (!email || !isValidEmail(email) || !mailerEnabled()) return links;

    const when = formatSlotLabel(b.startsAt, company.timezone);
    const service = b.product?.name ?? "tu cita";
    const subject =
      kind === "cancelled" ? `Cita cancelada: ${service} · ${when}` : kind === "rescheduled" ? `Cita reprogramada: ${service} · ${when}` : `Tu cita: ${service} · ${when}`;
    const intro =
      kind === "cancelled"
        ? `Tu cita de <b>${escapeHtml(service)}</b> con ${escapeHtml(company.name)} del ${escapeHtml(when)} fue cancelada.`
        : `Tu cita de <b>${escapeHtml(service)}</b> con ${escapeHtml(company.name)} quedó ${kind === "rescheduled" ? "reprogramada" : "confirmada"} para el <b>${escapeHtml(when)}</b>.`;
    const html = `
      <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">
        <p>${intro}</p>
        ${b.bookingCode ? `<p>Código de cita: <b>${escapeHtml(b.bookingCode)}</b></p>` : ""}
        ${kind !== "cancelled" && links ? `<p><a href="${links.google}" style="display:inline-block;padding:10px 16px;background:#6d5dfc;color:#fff;border-radius:8px;text-decoration:none">Agregar a Google Calendar</a></p><p style="font-size:13px;color:#555">En iPhone u Outlook acepta la invitación adjunta o descarga el archivo: <a href="${links.ics}">${links.ics}</a></p>` : ""}
        <p style="font-size:12px;color:#777">Enviado por ${escapeHtml(company.name)} vía FlowApp.</p>
      </div>`;
    const content = bookingIcs(b, company, { method: kind === "cancelled" ? "CANCEL" : "REQUEST" });
    await sendMail({
      to: email,
      fromName: `${company.name} vía FlowApp`,
      subject,
      html,
      text: `${intro.replace(/<[^>]+>/g, "")}${links && kind !== "cancelled" ? `\nGoogle Calendar: ${links.google}\niPhone/otros: ${links.ics}` : ""}`,
      icalEvent: { method: kind === "cancelled" ? "CANCEL" : "REQUEST", content },
    });
    return links;
  } catch (err) {
    console.error("[calendar] invitación por correo falló:", err instanceof Error ? err.message : err);
    return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function assertFeedToken(token: string): void {
  if (!/^cal_[0-9a-f]{48}$/.test(token)) throw new AppError("Calendario no encontrado", 404);
}
