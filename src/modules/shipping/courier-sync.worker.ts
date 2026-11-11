/**
 * Worker del catálogo de agencias (mismo patrón in-process que drive-index.worker:
 * node-cron cada 60 s, flags started/running). Sincroniza al arrancar si la copia no
 * existe o tiene más de COURIER_SYNC_HOURS, y luego cuando vuelve a vencer. Si la
 * descarga falla, se conserva la copia anterior y se reintenta cada 30 minutos.
 */

import cron from "node-cron";
import { env } from "../../config/env";
import { agencyCatalogStatus, syncShalomAgencies } from "./courier-sync.service";

let started = false;
let running = false;
let lastAttemptAt = 0;
const RETRY_EVERY_MS = 30 * 60_000;

export function startCourierSyncWorker(): void {
  if (started) return;
  started = true;
  if (!env.SHALOM_AGENCIES_URL) {
    console.log("[courier-sync] sin SHALOM_AGENCIES_URL: catálogo de agencias desactivado");
    return;
  }
  cron.schedule("* * * * *", () => {
    void tick().catch((err) => console.error("[courier-sync] tick error:", err instanceof Error ? err.message : err));
  });
  void tick().catch((err) => console.error("[courier-sync] arranque:", err instanceof Error ? err.message : err));
  console.log("[courier-sync] worker iniciado (cada 60s)");
}

async function tick(): Promise<void> {
  if (running) return;
  if (Date.now() - lastAttemptAt < RETRY_EVERY_MS) return;
  running = true;
  try {
    const status = await agencyCatalogStatus();
    const maxAgeMs = env.COURIER_SYNC_HOURS * 3_600_000;
    if (status.total > 0 && status.syncedAt && Date.now() - status.syncedAt.getTime() < maxAgeMs) return;
    lastAttemptAt = Date.now();
    const r = await syncShalomAgencies();
    if (r.ok) console.log(`[courier-sync] Shalom: ${r.total} agencias (${r.deactivated} dadas de baja)`);
    else console.error(`[courier-sync] Shalom: no se pudo actualizar (${r.error}); se conserva la copia anterior`);
  } finally {
    running = false;
  }
}
