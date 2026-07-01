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
import streamingInventoryRoutes from "../modules/streaming-inventory/streaming-inventory.routes";
import subscriptionsRoutes from "../modules/subscriptions/subscriptions.routes";
import receiptsRoutes from "../modules/receipts/receipts.routes";
import botRoutes from "../modules/bot/bot.routes";
import agentRoutes from "../modules/agent/agent.routes";
import metaWebhookRoutes from "../modules/meta-webhook/meta-webhook.routes";
import quickRepliesRoutes from "../modules/quick-replies/quick-replies.routes";
import crmRoutes from "../modules/crm/crm.routes";
import campaignsRoutes from "../modules/campaigns/campaigns.routes";
import flowsRoutes from "../modules/flows/flows.routes";
import dashboardRoutes from "../modules/dashboard/dashboard.routes";
import setupRoutes from "../modules/setup/setup.routes";
import adminConsoleRoutes from "../modules/admin-console/admin-console.routes";
import webhookEndpointsRoutes from "../modules/webhook-endpoints/webhook-endpoints.routes";
import webhooksRoutes from "../modules/webhooks/webhooks.routes";
import publicPaymentsRoutes from "../modules/public-payments/public-payments.routes";
import platformConfigPublicRoutes from "../modules/platform-config/platform-config.routes";

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
// Inventario de credenciales/cuentas de streaming (rubro STREAMER)
router.use("/streaming-inventory", streamingInventoryRoutes);
// Suscripciones/ventas con vencimiento (rubro STREAMER): seguimiento + recordatorio
router.use("/subscriptions", subscriptionsRoutes);
router.use("/receipts", receiptsRoutes);
router.use("/bot", botRoutes);
// Webhook inbound del agente autónomo (reemplaza n8n)
router.use("/agent", agentRoutes);
// Webhook de la API oficial de Meta WhatsApp (verificación GET + inbound/statuses
// POST firmados con X-Hub-Signature-256; tenant por metadata.phone_number_id)
router.use("/meta", metaWebhookRoutes);
// Respuestas rápidas del panel de conversaciones
router.use("/quick-replies", quickRepliesRoutes);
// CRM kanban (tableros, etiquetas internas, valores de negocio)
router.use("/crm", crmRoutes);
// Campañas de envío masivo (broadcast) por WhatsApp
router.use("/campaigns", campaignsRoutes);
// Flujos guiados de chatbot (alternativa al agente IA)
router.use("/flows", flowsRoutes);
// Métricas del dashboard del tenant
router.use("/dashboard", dashboardRoutes);
// Estado de activación / onboarding (checklist + % de avance)
router.use("/setup", setupRoutes);
router.use("/control-room-7m4x", adminConsoleRoutes);
// Gestión de endpoints de webhook (CRUD para admins)
router.use("/webhook-endpoints", webhookEndpointsRoutes);
// Recepción de webhooks entrantes (público, autenticado via HMAC)
router.use("/webhooks", webhooksRoutes);
// API pública para n8n (consulta y actualización de comprobantes; sin token,
// resuelve company por phone admin igual que /api/bot/config)
router.use("/public/payments", publicPaymentsRoutes);
// Config pública del landing (animación 3D elegida por el superadmin)
router.use("/public/landing", platformConfigPublicRoutes);

export default router;
