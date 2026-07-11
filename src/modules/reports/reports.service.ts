/**
 * Reportes automáticos del dashboard: config por tenant (destinatarios,
 * frecuencias, hora) y envío del Excel (mismas 9 pestañas del panel) por email
 * (SMTP genérico) y/o WhatsApp (documento por el canal del negocio).
 */

import path from "path";
import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";
import { mailerEnabled, sendMail } from "../../lib/mailer";
import { loadWhatsappSender, sendMedia } from "../agent/outbound";
import { getDashboardExportData } from "../dashboard/dashboard.service";
import { buildDashboardWorkbook } from "./report-workbook";
import { closedPeriodFor, type ReportKind } from "./reports.periods";
import type { UpdateReportConfigInput } from "./reports.schemas";

export type ChannelResult = "sent" | "skipped" | "error";

export interface SendReportResult {
  kind: ReportKind;
  period: { from: string; to: string };
  email: ChannelResult;
  whatsapp: ChannelResult;
  errors: string[];
}

const CONFIG_DEFAULTS = {
  email: null as string | null,
  waPhone: null as string | null,
  dailyEnabled: false,
  weeklyEnabled: false,
  monthlyEnabled: false,
  sendHour: 8,
  lastDailyKey: null as string | null,
  lastWeeklyKey: null as string | null,
  lastMonthlyKey: null as string | null,
  lastError: null as string | null,
};

export async function getReportConfig(companyId: string) {
  const row = await prisma.reportConfig.findUnique({ where: { companyId } });
  if (!row) return { ...CONFIG_DEFAULTS, mailerEnabled: mailerEnabled() };
  const { id: _id, companyId: _cid, createdAt: _c, updatedAt: _u, ...rest } = row;
  return { ...rest, mailerEnabled: mailerEnabled() };
}

export async function updateReportConfig(companyId: string, data: UpdateReportConfigInput) {
  const existing = await prisma.reportConfig.findUnique({ where: { companyId } });
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { timezone: true } });
  const tz = company?.timezone || "America/Lima";
  const now = new Date();

  // Al ACTIVAR un tipo se siembra su lastXKey con el período cerrado actual:
  // así el primer envío automático es al cerrar el SIGUIENTE período (activar
  // el toggle no dispara el reporte del período pasado al minuto — para eso
  // está "Enviar prueba"). También evita re-envíos al hacer toggle off/on.
  const seed = (enabledNow: boolean, enabledBefore: boolean, kind: ReportKind, prevKey: string | null) =>
    enabledNow && !enabledBefore ? closedPeriodFor(kind, now, tz).key : prevKey;

  const seeded = {
    lastDailyKey: seed(data.dailyEnabled, existing?.dailyEnabled ?? false, "daily", existing?.lastDailyKey ?? null),
    lastWeeklyKey: seed(data.weeklyEnabled, existing?.weeklyEnabled ?? false, "weekly", existing?.lastWeeklyKey ?? null),
    lastMonthlyKey: seed(
      data.monthlyEnabled,
      existing?.monthlyEnabled ?? false,
      "monthly",
      existing?.lastMonthlyKey ?? null,
    ),
  };

  await prisma.reportConfig.upsert({
    where: { companyId },
    create: { companyId, ...data, ...seeded },
    update: { ...data, ...seeded },
  });
  return getReportConfig(companyId);
}

/** Genera el Excel del período cerrado y lo envía a los destinos configurados. */
export async function sendReport(companyId: string, kind: ReportKind): Promise<SendReportResult> {
  const [config, company] = await Promise.all([
    prisma.reportConfig.findUnique({ where: { companyId } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true, timezone: true } }),
  ]);
  if (!company) throw new AppError("Empresa no encontrada", 404);
  if (!config || (!config.email && !config.waPhone)) {
    throw new AppError("Configura al menos un destinatario (correo o WhatsApp) y guarda antes de enviar.", 422);
  }

  const tz = company.timezone || "America/Lima";
  const period = closedPeriodFor(kind, new Date(), tz);

  const data = await getDashboardExportData({ companyId, from: period.from, to: period.to });
  const buffer = await buildDashboardWorkbook(data, { periodLabel: period.label });

  // Persistir bajo /uploads (público: SMS Tools descarga por URL). Sufijo
  // aleatorio para que la ruta no sea adivinable.
  const fileName = `reporte-${kind}-${period.from}-a-${period.to}-${randomBytes(4).toString("hex")}.xlsx`;
  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, "reports", companyId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), buffer);
  const url = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/uploads/reports/${companyId}/${fileName}`;

  const result: SendReportResult = {
    kind,
    period: { from: period.from, to: period.to },
    email: "skipped",
    whatsapp: "skipped",
    errors: [],
  };
  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // --- Email (cada canal en su try/catch: uno caído no bloquea al otro) ---
  if (config.email) {
    if (!mailerEnabled()) {
      result.errors.push("Email omitido: SMTP no configurado en el servidor (SMTP_HOST).");
    } else {
      try {
        const k = data.stats.kpis;
        const money = (n: number) => `${data.stats.currency} ${n.toFixed(2)}`;
        const kpiRow = (name: string, value: string) =>
          `<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;">${name}</td><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;">${value}</td></tr>`;
        await sendMail({
          to: config.email,
          subject: `📊 ${period.label} — ${company.name} (${period.from} a ${period.to})`,
          html: [
            `<p>Hola, este es el <strong>${period.label.toLowerCase()}</strong> de <strong>${company.name}</strong> del ${period.from} al ${period.to}.</p>`,
            `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">`,
            kpiRow("Ingresos", money(k.revenue.value)),
            kpiRow("Ventas", String(k.sales.value)),
            kpiRow("Ticket promedio", money(k.avgTicket.value)),
            kpiRow("Tasa de conversión", `${k.conversionRate.value}%`),
            `</table>`,
            `<p>El detalle completo va adjunto en Excel.</p>`,
          ].join("\n"),
          attachments: [{ filename: fileName, content: buffer }],
        });
        result.email = "sent";
      } catch (err) {
        result.email = "error";
        result.errors.push(`Email: ${errMsg(err)}`);
      }
    }
  }

  // --- WhatsApp (documento por el canal del negocio) ---
  if (config.waPhone) {
    try {
      const sender = await loadWhatsappSender(companyId);
      if (!sender) throw new Error("La empresa no tiene un canal de WhatsApp activo.");
      const to = config.waPhone.replace(/\D/g, "");
      const caption = `📊 ${period.label} — ${company.name} (${period.from} a ${period.to})`;
      await sendMedia(sender, to, "document", url, caption, fileName);
      result.whatsapp = "sent";
    } catch (err) {
      result.whatsapp = "error";
      result.errors.push(`WhatsApp: ${errMsg(err)}`);
    }
  }

  return result;
}
