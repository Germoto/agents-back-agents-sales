/**
 * Worker de reportes automáticos (mismo patrón in-process que el scheduler de
 * recordatorios: node-cron cada 60s, single-instance). Cada tick evalúa las
 * ReportConfig habilitadas y, cuando la hora local del tenant alcanza sendHour
 * y el período cerrado actual aún no se envió (lastXKey ≠ key), hace un claim
 * optimista sobre la key y dispara el envío. En fallo NO se revierte la key
 * (un intento por período; el error queda en lastError y el reenvío manual es
 * el botón "Enviar prueba" del panel).
 */

import cron from "node-cron";
import { prisma } from "../../lib/prisma";
import { sendReport } from "./reports.service";
import { closedPeriodFor, zonedNowParts, type ReportKind } from "./reports.periods";

let started = false;
let running = false;

export function startReportsWorker(): void {
  if (started) return;
  started = true;
  cron.schedule("* * * * *", () => {
    void tick().catch((err) =>
      console.error("[reports] tick error:", err instanceof Error ? err.message : err),
    );
  });
  console.log("[reports] worker de reportes automáticos iniciado (cada 60s)");
}

/** Claim atómico: marca la key del período como enviada; solo un tick gana.
 *  El OR con null es obligatorio (en Prisma `not` excluye los NULL). */
async function claimPeriod(configId: string, kind: ReportKind, key: string): Promise<boolean> {
  let count = 0;
  if (kind === "daily") {
    count = (
      await prisma.reportConfig.updateMany({
        where: { id: configId, OR: [{ lastDailyKey: null }, { lastDailyKey: { not: key } }] },
        data: { lastDailyKey: key },
      })
    ).count;
  } else if (kind === "weekly") {
    count = (
      await prisma.reportConfig.updateMany({
        where: { id: configId, OR: [{ lastWeeklyKey: null }, { lastWeeklyKey: { not: key } }] },
        data: { lastWeeklyKey: key },
      })
    ).count;
  } else {
    count = (
      await prisma.reportConfig.updateMany({
        where: { id: configId, OR: [{ lastMonthlyKey: null }, { lastMonthlyKey: { not: key } }] },
        data: { lastMonthlyKey: key },
      })
    ).count;
  }
  return count === 1;
}

async function tick(): Promise<void> {
  if (running) return; // un envío lento no debe solapar ticks
  running = true;
  try {
    const now = new Date();
    const configs = await prisma.reportConfig.findMany({
      where: { OR: [{ dailyEnabled: true }, { weeklyEnabled: true }, { monthlyEnabled: true }] },
      include: { company: { select: { timezone: true, isActive: true } } },
    });

    for (const cfg of configs) {
      if (!cfg.company.isActive) continue;
      if (!cfg.email && !cfg.waPhone) continue;
      const tz = cfg.company.timezone || "America/Lima";

      let hour: number;
      try {
        hour = zonedNowParts(now, tz).hour;
      } catch {
        continue; // TZ inválida: no reventar el tick
      }
      if (hour < cfg.sendHour) continue;

      const pending: Array<{ kind: ReportKind; key: string; lastKey: string | null }> = [];
      if (cfg.dailyEnabled) pending.push({ kind: "daily", key: closedPeriodFor("daily", now, tz).key, lastKey: cfg.lastDailyKey });
      if (cfg.weeklyEnabled) pending.push({ kind: "weekly", key: closedPeriodFor("weekly", now, tz).key, lastKey: cfg.lastWeeklyKey });
      if (cfg.monthlyEnabled) pending.push({ kind: "monthly", key: closedPeriodFor("monthly", now, tz).key, lastKey: cfg.lastMonthlyKey });

      for (const job of pending) {
        if (job.lastKey === job.key) continue; // fast-path: ya enviado
        if (!(await claimPeriod(cfg.id, job.kind, job.key))) continue;

        let lastError: string | null = null;
        try {
          const result = await sendReport(cfg.companyId, job.kind);
          lastError = result.errors.length ? result.errors.join(" | ") : null;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        await prisma.reportConfig
          .update({ where: { id: cfg.id }, data: { lastError } })
          .catch(() => undefined);
        if (lastError) console.error(`[reports] envío ${job.kind} company=${cfg.companyId}: ${lastError}`);
      }
    }
  } finally {
    running = false;
  }
}
