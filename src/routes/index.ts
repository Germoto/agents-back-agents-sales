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
import reportsRoutes from "../modules/reports/reports.routes";
import setupRoutes from "../modules/setup/setup.routes";
import adminConsoleRoutes from "../modules/admin-console/admin-console.routes";
import webhookEndpointsRoutes from "../modules/webhook-endpoints/webhook-endpoints.routes";
import webhooksRoutes from "../modules/webhooks/webhooks.routes";
import publicPaymentsRoutes from "../modules/public-payments/public-payments.routes";
import platformConfigPublicRoutes from "../modules/platform-config/platform-config.routes";
import billingRoutes from "../modules/billing/billing.routes";
import billingPublicRoutes from "../modules/billing/billing-public.routes";
import { billingGuard } from "../middlewares/billing.middleware";

const router = Router();

// billingGuard: monetización SaaS. Con `module` exige que el paquete del
// tenant incluya ese módulo; sin argumentos solo bloquea ESCRITURAS cuando la
// suscripción está vencida. Empresas sin suscripción (legacy) pasan siempre.
// NO montarlo en /auth, /billing, /setup, /bot, /agent, /meta, /webhooks,
// /public/* ni /control-room-7m4x.
router.use("/auth", authRoutes);
router.use("/business", billingGuard(), businessRoutes);
router.use("/agent-config", billingGuard(), agentConfigRoutes);
router.use("/whatsapp-config", billingGuard(), whatsappConfigRoutes);
router.use("/payment-config", billingGuard(), paymentConfigRoutes);
router.use("/products", billingGuard(), productsRoutes);
router.use("/product-files", billingGuard(), productFilesRoutes);
router.use("/customers", billingGuard(), customersRoutes);
router.use("/orders", billingGuard(), ordersRoutes);
router.use("/digital-sales", billingGuard(), digitalSalesRoutes);
// Inventario de credenciales/cuentas de streaming (rubro STREAMER)
router.use("/streaming-inventory", billingGuard(), streamingInventoryRoutes);
// Suscripciones/ventas con vencimiento (rubro STREAMER): seguimiento + recordatorio
router.use("/subscriptions", billingGuard(), subscriptionsRoutes);
router.use("/receipts", billingGuard(), receiptsRoutes);
router.use("/bot", botRoutes);
// Webhook inbound del agente autónomo (reemplaza n8n)
router.use("/agent", agentRoutes);
// Webhook de la API oficial de Meta WhatsApp (verificación GET + inbound/statuses
// POST firmados con X-Hub-Signature-256; tenant por metadata.phone_number_id)
router.use("/meta", metaWebhookRoutes);
// Respuestas rápidas del panel de conversaciones
router.use("/quick-replies", billingGuard({ module: "QUICK_REPLIES" }), quickRepliesRoutes);
// CRM kanban (tableros, etiquetas internas, valores de negocio). El embudo
// (GET /crm/funnel) es su propio módulo de paquete: se gatea como FUNNEL.
router.use(
  "/crm",
  (req, res, next) => billingGuard({ module: req.path.startsWith("/funnel") ? "FUNNEL" : "CRM" })(req, res, next),
  crmRoutes,
);
// Campañas de envío masivo (broadcast) por WhatsApp
router.use("/campaigns", billingGuard({ module: "CAMPAIGNS" }), campaignsRoutes);
// Flujos guiados de chatbot (alternativa al agente IA)
router.use("/flows", billingGuard({ module: "FLOWS" }), flowsRoutes);
// Métricas del dashboard del tenant
router.use("/dashboard", billingGuard(), dashboardRoutes);
// Reportes automáticos del dashboard (config + envío de prueba)
router.use("/reports", billingGuard(), reportsRoutes);
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
// Billing del tenant (Mi plan, canje de vales, créditos). Debe funcionar
// también con la suscripción vencida: NUNCA montarle billingGuard.
router.use("/billing", billingRoutes);
// Paquetes públicos para la sección Precios del landing
router.use("/public/plans", billingPublicRoutes);

export default router;
