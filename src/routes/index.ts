import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes";
import businessRoutes from "../modules/business/business.routes";
import agentConfigRoutes from "../modules/agent-config/agent-config.routes";
import whatsappConfigRoutes from "../modules/whatsapp-config/whatsapp-config.routes";
import paymentConfigRoutes from "../modules/payment-config/payment-config.routes";
import productsRoutes from "../modules/products/products.routes";
import customersRoutes from "../modules/customers/customers.routes";
import ordersRoutes from "../modules/orders/orders.routes";
import digitalSalesRoutes from "../modules/digital-sales/digital-sales.routes";
import receiptsRoutes from "../modules/receipts/receipts.routes";
import botRoutes from "../modules/bot/bot.routes";
import adminConsoleRoutes from "../modules/admin-console/admin-console.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/business", businessRoutes);
router.use("/agent-config", agentConfigRoutes);
router.use("/whatsapp-config", whatsappConfigRoutes);
router.use("/payment-config", paymentConfigRoutes);
router.use("/products", productsRoutes);
router.use("/customers", customersRoutes);
router.use("/orders", ordersRoutes);
router.use("/digital-sales", digitalSalesRoutes);
router.use("/receipts", receiptsRoutes);
router.use("/bot", botRoutes);
router.use("/control-room-7m4x", adminConsoleRoutes);

export default router;
