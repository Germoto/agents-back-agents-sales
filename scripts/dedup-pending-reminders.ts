/**
 * Limpieza one-time: cancela recordatorios PENDING DUPLICADOS que se acumularon por
 * el bug de cancelación (cancelPendingReminders no cancelaba los automáticos). Agrupa
 * los PENDING por (companyId, customerId, type, body, mediaUrl), conserva el de sendAt
 * MÁS ANTIGUO de cada grupo y marca el resto como CANCELLED. No toca los manuales
 * (metadata.manual=true) ni nada que no sea status PENDING. Idempotente.
 *
 * Correr una sola vez contra la BD (con DATABASE_URL del entorno objetivo):
 *   npx ts-node --transpile-only scripts/dedup-pending-reminders.ts
 *   (agrega --apply para ejecutar; sin él hace dry-run y solo reporta)
 */
import { PrismaClient, ScheduledMessageStatus } from "@prisma/client";

const prisma = new PrismaClient();

function isManual(m: unknown): boolean {
  return !!m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>).manual === true;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.scheduledMessage.findMany({
    where: { status: ScheduledMessageStatus.PENDING },
    select: { id: true, companyId: true, customerId: true, type: true, body: true, mediaUrl: true, sendAt: true, metadata: true },
    orderBy: { sendAt: "asc" }, // el primero de cada grupo será el más antiguo
  });

  const seen = new Set<string>();
  const toCancel: string[] = [];
  for (const r of rows) {
    if (isManual(r.metadata)) continue; // los manuales no se tocan
    const key = `${r.companyId}|${r.customerId}|${r.type}|${r.body}|${r.mediaUrl ?? ""}`;
    if (seen.has(key)) toCancel.push(r.id);
    else seen.add(key);
  }

  console.log(`[dedup] PENDING revisados: ${rows.length}`);
  console.log(`[dedup] grupos únicos (se conservan): ${seen.size}`);
  console.log(`[dedup] duplicados a cancelar: ${toCancel.length}`);

  if (!apply) {
    console.log("[dedup] DRY-RUN: nada cambiado. Vuelve a correr con --apply para aplicar.");
    return;
  }
  if (toCancel.length) {
    const res = await prisma.scheduledMessage.updateMany({
      where: { id: { in: toCancel }, status: ScheduledMessageStatus.PENDING },
      data: { status: ScheduledMessageStatus.CANCELLED },
    });
    console.log(`[dedup] cancelados: ${res.count}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
