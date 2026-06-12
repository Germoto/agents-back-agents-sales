import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes";
import businessRoutes from "../modules/business/business.routes";
import agentConfigRoutes from "../modules/agent-config/agent-config.routes";
import whatsappConfigRoutes from "../modules/whatsapp-config/whatsapp-config.routes";
import paymentConfigRoutes from "../modules/payment-config/payment-config.routes";
import productsRoutes from "../modules/products/products.routes";
import productFilesRoutes from "../modules/product-files/product-files.routes";
import customersRoutes from "../modules/customers/customers.routes";
import ordersRoutes from "../modules/orders/orders.routes";
import digitalSalesRoutes from "../modules/digital-sales/digital-sales.routes";
import receiptsRoutes from "../modules/receipts/receipts.routes";
import botRoutes from "../modules/bot/bot.routes";
import agentRoutes from "../modules/agent/agent.routes";
import quickRepliesRoutes from "../modules/quick-replies/quick-replies.routes";
import crmRoutes from "../modules/crm/crm.routes";
import flowsRoutes from "../modules/flows/flows.routes";
import dashboardRoutes from "../modules/dashboard/dashboard.routes";
import adminConsoleRoutes from "../modules/admin-console/admin-console.routes";
import webhookEndpointsRoutes from "../modules/webhook-endpoints/webhook-endpoints.routes";
import webhooksRoutes from "../modules/webhooks/webhooks.routes";
import publicPaymentsRoutes from "../modules/public-payments/public-payments.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/business", businessRoutes);
router.use("/agent-config", agentConfigRoutes);
router.use("/whatsapp-config", whatsappConfigRoutes);
router.use("/payment-config", paymentConfigRoutes);
router.use("/products", productsRoutes);
router.use("/product-files", productFilesRoutes);
router.use("/customers", customersRoutes);
router.use("/orders", ordersRoutes);
router.use("/digital-sales", digitalSalesRoutes);
router.use("/receipts", receiptsRoutes);
router.use("/bot", botRoutes);
// Webhook inbound del agente autónomo (reemplaza n8n)
router.use("/agent", agentRoutes);
// Respuestas rápidas del panel de conversaciones
router.use("/quick-replies", quickRepliesRoutes);
// CRM kanban (tableros, etiquetas internas, valores de negocio)
router.use("/crm", crmRoutes);
// Flujos guiados de chatbot (alternativa al agente IA)
router.use("/flows", flowsRoutes);
// Métricas del dashboard del tenant
router.use("/dashboard", dashboardRoutes);
router.use("/control-room-7m4x", adminConsoleRoutes);
// Gestión de endpoints de webhook (CRUD para admins)
router.use("/webhook-endpoints", webhookEndpointsRoutes);
// Recepción de webhooks entrantes (público, autenticado via HMAC)
router.use("/webhooks", webhooksRoutes);
// API pública para n8n (consulta y actualización de comprobantes; sin token,
// resuelve company por phone admin igual que /api/bot/config)
router.use("/public/payments", publicPaymentsRoutes);

export default router;
