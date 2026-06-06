import { createServer } from "http";
import { env } from "./config/env";
import { app } from "./app";
import { socketService } from "./lib/socket";
import { startScheduler } from "./modules/scheduler/scheduler.worker";

const httpServer = createServer(app);

// Inicializar Socket.IO sobre el mismo servidor HTTP
socketService.init(httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT} (HTTP + WebSocket)`);
  // Worker de recordatorios/seguimientos (node-cron, in-process)
  startScheduler();
});
