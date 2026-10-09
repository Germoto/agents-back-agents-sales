/**
 * Worker de la tienda web. Cada 60 s reintenta el matching de los pedidos
 * Yape/Plin EN_REVISION (el comprobante del origen — ValidPay — puede llegar
 * después de que el comprador suba su captura) y, agotados los intentos, avisa
 * al dueño para que lo apruebe desde el panel. In-process, como el scheduler.
 */

import cron from "node-cron";
import { recheckStoreOrdersInReview } from "./storefront.service";

let running = false;

export function startStorefrontWorker() {
  cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await recheckStoreOrdersInReview();
    } catch (err) {
      console.error("[storefront] worker error:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  });
  console.log("[storefront] worker de pedidos en revisión iniciado (cada 60 s)");
}
