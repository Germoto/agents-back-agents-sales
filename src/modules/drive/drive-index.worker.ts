/**
 * Worker del índice de Drive (mismo patrón in-process que reports.worker: node-cron
 * cada 60 s, flags started/running). Al arrancar encola la construcción de todos los
 * productos digitales con links de Drive en la entrega (empresas activas); luego
 * rehace cada índice cuando vence su nextSyncAt (DRIVE_INDEX_REFRESH_HOURS) y relee
 * la lista de productos cada hora para sumar los nuevos. Sin API key no hace nada.
 */

import cron from "node-cron";
import { prisma } from "../../lib/prisma";
import { driveSearchEnabled, deliveryDriveRefs } from "../../lib/google-drive";
import { ensureIndex, getIndex, isBuilding, type DriveProductLike } from "./drive-index.service";

let started = false;
let running = false;
let known: DriveProductLike[] = [];
let lastScanAt = 0;
const SCAN_EVERY_MS = 60 * 60_000;

export function startDriveIndexWorker(): void {
  if (started) return;
  started = true;
  if (!driveSearchEnabled()) {
    console.log("[drive-index] sin GOOGLE_DRIVE_API_KEY: índice de Drive desactivado");
    return;
  }
  cron.schedule("* * * * *", () => {
    void tick().catch((err) => console.error("[drive-index] tick error:", err instanceof Error ? err.message : err));
  });
  // Primera pasada inmediata: que el índice esté listo minutos después del arranque.
  void tick().catch((err) => console.error("[drive-index] arranque:", err instanceof Error ? err.message : err));
  console.log("[drive-index] worker iniciado (cada 60s)");
}

/** Productos digitales de empresas activas cuya entrega tiene links de Drive. */
export async function scanDriveProducts(): Promise<DriveProductLike[]> {
  const rows = await prisma.product.findMany({
    where: { productType: "DIGITAL", active: true, company: { isActive: true } },
    select: { id: true, companyId: true, digitalDelivery: { select: { instructions: true, followupMessages: true } } },
  });
  return rows
    .map((p) => {
      const fu = p.digitalDelivery?.followupMessages;
      return {
        id: p.id,
        companyId: p.companyId,
        digitalDelivery: { instructions: p.digitalDelivery?.instructions ?? "", followupMessages: Array.isArray(fu) ? (fu as Array<{ message?: string }>) : [] },
      };
    })
    .filter((p) => deliveryDriveRefs(p.digitalDelivery).length > 0);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (Date.now() - lastScanAt >= SCAN_EVERY_MS) {
      known = await scanDriveProducts();
      lastScanAt = Date.now();
    }
    for (const p of known) {
      if (isBuilding(p.id)) continue;
      const idx = getIndex(p.id);
      if (!idx || idx.nextSyncAt.getTime() <= Date.now()) ensureIndex(p);
    }
  } finally {
    running = false;
  }
}
