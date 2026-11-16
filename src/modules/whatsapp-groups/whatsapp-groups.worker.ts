/**
 * Worker de grupos de WhatsApp: cada minuto despacha, por cada grupo con cola, un
 * lote de hasta 20 números y deja el siguiente a 10–15 minutos (ritmo del gateway).
 * El estado vive en la base, así que sobrevive a reinicios.
 */

import cron from "node-cron";
import { runGroupQueueTick } from "./whatsapp-groups.service";

let started = false;
let running = false;

export function startWhatsappGroupsWorker(): void {
  if (started) return;
  started = true;
  cron.schedule("* * * * *", () => {
    if (running) return;
    running = true;
    void runGroupQueueTick()
      .catch((err) => console.error("[wa-groups] tick error:", err instanceof Error ? err.message : err))
      .finally(() => {
        running = false;
      });
  });
}
