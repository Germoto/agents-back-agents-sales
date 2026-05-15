"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bcrypt_1 = __importDefault(require("bcrypt"));
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    const passwordHash = await bcrypt_1.default.hash("123456", 10);
    const company = await prisma.company.upsert({
        where: { slug: "tienda-demo" },
        update: {
            name: "Tienda Demo",
            adminPhone: "+51963337953",
        },
        create: {
            name: "Tienda Demo",
            slug: "tienda-demo",
            adminPhone: "+51963337953",
            timezone: "America/Lima",
        },
    });
    await prisma.user.upsert({
        where: { phone: "963337953" },
        update: {
            name: "Admin Demo",
            passwordHash,
            role: client_1.UserRole.ADMIN,
            companyId: company.id,
            isActive: true,
        },
        create: {
            companyId: company.id,
            name: "Admin Demo",
            phone: "963337953",
            passwordHash,
            role: client_1.UserRole.ADMIN,
            isActive: true,
        },
    });
    await prisma.agentConfig.upsert({
        where: { companyId: company.id },
        update: {
            openaiModel: "gpt-4o-mini",
            temperature: "0.25",
            basePrompt: "Eres un agente vendedor por WhatsApp. Responde claro, breve y enfocado en cerrar la venta con honestidad.",
            salesStyle: "consultivo",
            rules: [
                "Responde en español.",
                "No inventes stock ni promociones.",
                "Pide datos de entrega solo cuando el cliente confirme compra."
            ],
        },
        create: {
            companyId: company.id,
            openaiModel: "gpt-4o-mini",
            temperature: "0.25",
            basePrompt: "Eres un agente vendedor por WhatsApp. Responde claro, breve y enfocado en cerrar la venta con honestidad.",
            salesStyle: "consultivo",
            rules: [
                "Responde en español.",
                "No inventes stock ni promociones.",
                "Pide datos de entrega solo cuando el cliente confirme compra."
            ],
        },
    });
    await prisma.whatsappConfig.upsert({
        where: { companyId: company.id },
        update: {
            apiUrl: "https://smstools.molanosoft.com/api/send/whatsapp",
            secret: "demo-whatsapp-secret",
            account: "ACCOUNT_WA_DEMO",
            isActive: true,
        },
        create: {
            companyId: company.id,
            apiUrl: "https://smstools.molanosoft.com/api/send/whatsapp",
            secret: "demo-whatsapp-secret",
            account: "ACCOUNT_WA_DEMO",
            isActive: true,
        },
    });
    await prisma.paymentConfig.upsert({
        where: { companyId: company.id },
        update: {
            enabled: true,
            method: "Yape / Plin",
            number: "963337953",
            holder: "Titular Demo",
            paymentMode: client_1.PaymentMode.BEFORE_DELIVERY,
        },
        create: {
            companyId: company.id,
            enabled: true,
            method: "Yape / Plin",
            number: "963337953",
            holder: "Titular Demo",
            paymentMode: client_1.PaymentMode.BEFORE_DELIVERY,
        },
    });
    const digital = await prisma.product.upsert({
        where: {
            companyId_slug: {
                companyId: company.id,
                slug: "mega_pack_ia",
            },
        },
        update: {
            active: true,
            productType: client_1.ProductType.DIGITAL,
            name: "Mega Pack IA",
            price: "S/ 4.90",
            regularPrice: "S/ 50.00",
            stock: null,
            shortDescription: "Pack digital con prompts, automatizaciones y recursos de IA.",
            fullDescription: "Incluye recursos listos para vender, automatizar y crear contenido con herramientas de inteligencia artificial.",
            deliveryMethod: "Entrega automática por enlace",
            support: "Soporte por WhatsApp por 7 días",
            sortOrder: 1,
        },
        create: {
            companyId: company.id,
            slug: "mega_pack_ia",
            active: true,
            productType: client_1.ProductType.DIGITAL,
            name: "Mega Pack IA",
            price: "S/ 4.90",
            regularPrice: "S/ 50.00",
            stock: null,
            shortDescription: "Pack digital con prompts, automatizaciones y recursos de IA.",
            fullDescription: "Incluye recursos listos para vender, automatizar y crear contenido con herramientas de inteligencia artificial.",
            deliveryMethod: "Entrega automática por enlace",
            support: "Soporte por WhatsApp por 7 días",
            sortOrder: 1,
        },
    });
    const physical = await prisma.product.upsert({
        where: {
            companyId_slug: {
                companyId: company.id,
                slug: "kit_emprendedor",
            },
        },
        update: {
            active: true,
            productType: client_1.ProductType.PHYSICAL,
            name: "Kit Emprendedor",
            price: "S/ 89.00",
            regularPrice: "S/ 120.00",
            stock: 20,
            shortDescription: "Kit físico para iniciar ventas por WhatsApp.",
            fullDescription: "Incluye guía impresa, plantillas y material de apoyo para acelerar la implementación comercial.",
            deliveryMethod: "Delivery a domicilio",
            support: "Soporte por WhatsApp por 15 días",
            sortOrder: 2,
        },
        create: {
            companyId: company.id,
            slug: "kit_emprendedor",
            active: true,
            productType: client_1.ProductType.PHYSICAL,
            name: "Kit Emprendedor",
            price: "S/ 89.00",
            regularPrice: "S/ 120.00",
            stock: 20,
            shortDescription: "Kit físico para iniciar ventas por WhatsApp.",
            fullDescription: "Incluye guía impresa, plantillas y material de apoyo para acelerar la implementación comercial.",
            deliveryMethod: "Delivery a domicilio",
            support: "Soporte por WhatsApp por 15 días",
            sortOrder: 2,
        },
    });
    await prisma.productAlias.deleteMany({ where: { productId: { in: [digital.id, physical.id] } } });
    await prisma.productBenefit.deleteMany({ where: { productId: { in: [digital.id, physical.id] } } });
    await prisma.productInclude.deleteMany({ where: { productId: { in: [digital.id, physical.id] } } });
    await prisma.productBonus.deleteMany({ where: { productId: { in: [digital.id, physical.id] } } });
    await prisma.productFaq.deleteMany({ where: { productId: { in: [digital.id, physical.id] } } });
    await prisma.productObjection.deleteMany({ where: { productId: { in: [digital.id, physical.id] } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: [digital.id, physical.id] } } });
    await prisma.productMedia.upsert({
        where: { productId: digital.id },
        update: {
            imageUrl: "https://images.example.com/mega-pack-ia.jpg",
            pdfUrl: "https://docs.example.com/mega-pack-ia.pdf",
            videoUrl: "https://youtube.com/watch?v=demo-pack-ia",
        },
        create: {
            productId: digital.id,
            imageUrl: "https://images.example.com/mega-pack-ia.jpg",
            pdfUrl: "https://docs.example.com/mega-pack-ia.pdf",
            videoUrl: "https://youtube.com/watch?v=demo-pack-ia",
        },
    });
    await prisma.productMedia.upsert({
        where: { productId: physical.id },
        update: {
            imageUrl: "https://images.example.com/kit-emprendedor.jpg",
            pdfUrl: null,
            videoUrl: "https://youtube.com/watch?v=demo-kit-emprendedor",
        },
        create: {
            productId: physical.id,
            imageUrl: "https://images.example.com/kit-emprendedor.jpg",
            pdfUrl: null,
            videoUrl: "https://youtube.com/watch?v=demo-kit-emprendedor",
        },
    });
    await prisma.digitalDelivery.upsert({
        where: { productId: digital.id },
        update: {
            link: "https://drive.google.com/demo-mega-pack-ia",
            instructions: "Después de validar el pago, comparte este enlace y recuerda indicar que lo guarde.",
        },
        create: {
            productId: digital.id,
            link: "https://drive.google.com/demo-mega-pack-ia",
            instructions: "Después de validar el pago, comparte este enlace y recuerda indicar que lo guarde.",
        },
    });
    await prisma.physicalDelivery.upsert({
        where: { productId: physical.id },
        update: {
            requiresAddress: true,
            deliveryCost: "S/ 10.00",
            deliveryTime: "24 a 48 horas",
            pickupAvailable: true,
            deliveryAreas: ["Lima Centro", "San Isidro", "Miraflores"],
        },
        create: {
            productId: physical.id,
            requiresAddress: true,
            deliveryCost: "S/ 10.00",
            deliveryTime: "24 a 48 horas",
            pickupAvailable: true,
            deliveryAreas: ["Lima Centro", "San Isidro", "Miraflores"],
        },
    });
    await prisma.productAlias.createMany({
        data: [
            { productId: digital.id, value: "ia" },
            { productId: digital.id, value: "chatgpt" },
            { productId: physical.id, value: "kit" },
            { productId: physical.id, value: "emprendedor" },
        ],
    });
    await prisma.productBenefit.createMany({
        data: [
            { productId: digital.id, value: "Acceso inmediato", sortOrder: 1 },
            { productId: digital.id, value: "Prompts probados para ventas", sortOrder: 2 },
            { productId: physical.id, value: "Material tangible para capacitación", sortOrder: 1 },
            { productId: physical.id, value: "Ideal para equipos comerciales", sortOrder: 2 },
        ],
    });
    await prisma.productInclude.createMany({
        data: [
            { productId: digital.id, value: "Prompts de venta", sortOrder: 1 },
            { productId: digital.id, value: "Guía de implementación", sortOrder: 2 },
            { productId: physical.id, value: "Manual impreso", sortOrder: 1 },
            { productId: physical.id, value: "Plantillas de seguimiento", sortOrder: 2 },
        ],
    });
    await prisma.productBonus.createMany({
        data: [
            { productId: digital.id, value: "Bono de 50 ideas de contenido", sortOrder: 1 },
            { productId: physical.id, value: "Checklist de ventas", sortOrder: 1 },
        ],
    });
    await prisma.productVariant.createMany({
        data: [
            { productId: physical.id, name: "Color", options: ["Azul", "Negro"], sortOrder: 1 },
        ],
    });
    const customer = await prisma.customer.upsert({
        where: {
            companyId_phone: {
                companyId: company.id,
                phone: "51999999999",
            },
        },
        update: {
            name: "Cliente Demo",
            email: "cliente@example.com",
            status: "interesado",
            selectedProductId: digital.id,
            lastInteractionAt: new Date(),
            metadata: { source: "seed" },
        },
        create: {
            companyId: company.id,
            phone: "51999999999",
            name: "Cliente Demo",
            email: "cliente@example.com",
            status: "interesado",
            selectedProductId: digital.id,
            lastInteractionAt: new Date(),
            metadata: { source: "seed" },
        },
    });
    await prisma.conversationMessage.create({
        data: {
            companyId: company.id,
            customerId: customer.id,
            productId: digital.id,
            role: client_1.ConversationRole.USER,
            message: "Hola, quiero más información del Mega Pack IA.",
            rawPayload: { seed: true },
        },
    });
    const digitalSale = await prisma.digitalSale.create({
        data: {
            companyId: company.id,
            customerId: customer.id,
            productId: digital.id,
            amountExpected: "S/ 4.90",
            status: client_1.DigitalSaleStatus.ESPERANDO_PAGO,
        },
    });
    await prisma.paymentReceipt.create({
        data: {
            companyId: company.id,
            customerId: customer.id,
            productId: digital.id,
            digitalSaleId: digitalSale.id,
            mediaUrl: "https://images.example.com/receipt-demo.jpg",
            amountExpected: "S/ 4.90",
            status: client_1.ReceiptStatus.PENDIENTE,
        },
    });
    await prisma.order.create({
        data: {
            companyId: company.id,
            customerId: customer.id,
            productId: physical.id,
            orderCode: "ORD-DEMO-001",
            quantity: 1,
            customerName: "Cliente Demo",
            address: "Av. Demo 123",
            reference: "Puerta gris",
            notes: "Entregar por la tarde",
            status: client_1.OrderStatus.PEDIDO_REGISTRADO,
        },
    });
    console.log("Seed completado");
}
main()
    .catch((error) => {
    console.error(error);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
