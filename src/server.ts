import { createServer } from "http";
import { env } from "./config/env";
import { app } from "./app";
import { socketService } from "./lib/socket";
import { startScheduler } from "./modules/scheduler/scheduler.worker";
import { startDeliveryStatusWorker } from "./modules/agent/delivery-status.worker";
import { startReportsWorker } from "./modules/reports/reports.worker";
import { resumeRunningCampaigns } from "./modules/campaigns/campaign-driver";
import { startStorefrontWorker } from "./modules/storefront/storefront.worker";
import { ensureSalesAgentBootTouchups } from "./modules/admin-console/sales-agent.service";
import { startDriveIndexWorker } from "./modules/drive/drive-index.worker";
import { startCourierSyncWorker } from "./modules/shipping/courier-sync.worker";
import { startWhatsappProvisionWorker } from "./modules/whatsapp-config/whatsapp-provision.worker";

const httpServer = createServer(app);

// Inicializar Socket.IO sobre el mismo servidor HTTP
socketService.init(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT} (HTTP + WebSocket)`);
  // Worker de recordatorios/seguimientos (node-cron, in-process)
  startScheduler();
  // Worker de estado de entrega: reintenta mensajes que el gateway marcó failed
  startDeliveryStatusWorker();
  // Worker de reportes automáticos del dashboard (email/WhatsApp)
  startReportsWorker();
  // Tienda web: reintenta validar pedidos Yape/Plin en revisión.
  startStorefrontWorker();
  // Índice en memoria de las carpetas de Drive de la entrega (solo con GOOGLE_DRIVE_API_KEY).
  startDriveIndexWorker();
  // Catálogo de agencias de courier (Shalom): copia local que se refresca sola.
  startCourierSyncWorker();
  // Alta automática: completa el canal SMS Tools de las cuentas que nacieron con el proveedor caído.
  startWhatsappProvisionWorker();
  // Reanuda las campañas masivas que quedaron en ejecución antes del reinicio
  void resumeRunningCampaigns();
  // Ajustes idempotentes del tenant de plataforma (agente de ventas del landing)
  void ensureSalesAgentBootTouchups();
});
