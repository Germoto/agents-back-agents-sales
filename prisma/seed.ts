import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function resetDemoData() {
  await prisma.paymentReceipt.deleteMany();
  await prisma.digitalSale.deleteMany();
  await prisma.order.deleteMany();
  await prisma.conversationMessage.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.digitalDelivery.deleteMany();
  await prisma.physicalDelivery.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.productFile.deleteMany();
  await prisma.productObjection.deleteMany();
  await prisma.productFaq.deleteMany();
  await prisma.productBonus.deleteMany();
  await prisma.productInclude.deleteMany();
  await prisma.productBenefit.deleteMany();
  await prisma.productAlias.deleteMany();
  await prisma.product.deleteMany();
  await prisma.paymentMethod.deleteMany();
  await prisma.paymentConfig.deleteMany();
  await prisma.whatsappConfig.deleteMany();
  await prisma.agentConfig.deleteMany();
  await prisma.user.deleteMany();
  await prisma.company.deleteMany();
}

async function main() {
  const passwordHash = await bcrypt.hash("123456", 10);
  const defaultAdminPhone = "+51997948783";
  const superadminPhone = "+51963337953";

  await resetDemoData();

  const company = await prisma.company.create({
    data: {
      name: "Tienda Demos",
      slug: "tienda-demos",
      adminPhone: defaultAdminPhone,
      timezone: "America/Lima",
      isActive: true,
    },
  });

  await prisma.user.create({
    data: {
      companyId: company.id,
      name: "Admin Demo",
      phone: defaultAdminPhone,
      passwordHash,
      role: "ADMIN",
      isActive: true,
    },
  });

  await prisma.user.create({
    data: {
      companyId: company.id,
      name: "Control Maestro",
      phone: superadminPhone,
      passwordHash,
      role: "SUPERADMIN",
      isActive: true,
    },
  });

  await prisma.agentConfig.create({
    data: {
      companyId: company.id,
      openaiModel: "gpt-4.1-mini",
      openaiApiKey: "sk-demo-openai-key",
      temperature: "0.25",
      basePrompt:
        "Eres un agente vendedor por WhatsApp. Responde claro, breve y enfocado en cerrar la venta con honestidad.",
      salesStyle: "consultivo",
      rules: [
        "Responde en español.",
        "No inventes stock ni promociones.",
        "Pide datos de entrega solo cuando el cliente confirme compra.",
      ],
    },
  });

  const whatsappConfig = await prisma.whatsappConfig.create({
    data: {
      companyId: company.id,
      apiUrl: "https://smstools.pro/api/send/whatsapp",
      secret: "9187147171baf7eb01136414276272c793403885",
      account: "1776450964c4ca4238a0b923820dcc509a6f75849b69e27d9428a35",
      isActive: true,
    },
  });

  const paymentConfig = await prisma.paymentConfig.create({
    data: {
      companyId: company.id,
      enabled: true,
      paymentMode: "BEFORE_DELIVERY",
      notificationPhone: defaultAdminPhone,
    },
  });

  await prisma.paymentMethod.createMany({
    data: [
      {
        paymentConfigId: paymentConfig.id,
        method: "Yape",
        number: defaultAdminPhone,
        holder: "Titular Demo",
        sortOrder: 0,
      },
      {
        paymentConfigId: paymentConfig.id,
        method: "Transferencia BCP",
        number: "001-1234567890",
        holder: "Titular Demo",
        sortOrder: 1,
      },
    ],
  });

  const digital = await prisma.product.create({
    data: {
      companyId: company.id,
      slug: "mega_pack_ia",
      active: true,
      productType: "DIGITAL",
      name: "Mega Pack IA",
      price: "S/ 4.90",
      regularPrice: "S/ 50.00",
      stock: null,
      shortDescription: "Pack digital con prompts, automatizaciones y recursos de IA.",
      fullDescription:
        "Incluye recursos listos para vender, automatizar y crear contenido con herramientas de inteligencia artificial.",
      deliveryMethod: "Entrega automática por enlace",
      support: "Soporte por WhatsApp por 7 días",
      sortOrder: 1,
    },
  });

  const physical = await prisma.product.create({
    data: {
      companyId: company.id,
      slug: "kit_emprendedor",
      active: true,
      productType: "PHYSICAL",
      name: "Kit Emprendedor",
      price: "S/ 89.00",
      regularPrice: "S/ 120.00",
      stock: 20,
      shortDescription: "Kit físico para iniciar ventas por WhatsApp.",
      fullDescription:
        "Incluye guía impresa, plantillas y material de apoyo para acelerar la implementación comercial.",
      deliveryMethod: "Delivery a domicilio",
      support: "Soporte por WhatsApp por 15 días",
      sortOrder: 2,
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
    data: [{ productId: physical.id, name: "Color", options: ["Azul", "Negro"], sortOrder: 1 }],
  });

  await prisma.productFile.createMany({
    data: [
      {
        productId: digital.id,
        type: "IMAGE",
        url: "https://marketingdiez.com/wp-content/uploads/2023/05/infoproductos.png",
        description: "Imagen principal del producto",
        sortOrder: 0,
      },
      {
        productId: digital.id,
        type: "PDF",
        url: "https://networkingcontraelparo.com/wp-content/uploads/2024/02/Guia-15-Infoproductos-que-puedes-crear-y-vender.pdf",
        description: "Documento PDF del producto",
        sortOrder: 1,
      },
      {
        productId: digital.id,
        type: "VIDEO",
        url: "https://www.youtube.com/watch?v=z7Sz4hSKwas",
        description: "Video del producto",
        sortOrder: 2,
      },
      {
        productId: physical.id,
        type: "IMAGE",
        url: "https://images.example.com/kit-emprendedor.jpg",
        description: "Imagen principal del producto",
        sortOrder: 0,
      },
      {
        productId: physical.id,
        type: "VIDEO",
        url: "https://youtube.com/watch?v=demo-kit-emprendedor",
        description: "Video del producto",
        sortOrder: 2,
      },
    ],
  });

  await prisma.digitalDelivery.create({
    data: {
      productId: digital.id,
      link: "https://drive.google.com/drive/folders/1ruViJ__6X_hOQATCidPaf7EdK27mjABW?usp=sharing",
      instructions: "Después de validar el pago, comparte este enlace y recuerda indicar que lo guarde.",
    },
  });

  await prisma.physicalDelivery.create({
    data: {
      productId: physical.id,
      requiresAddress: true,
      deliveryCost: "S/ 10",
      deliveryTime: "24 a 48 horas",
      pickupAvailable: true,
      deliveryAreas: ["Lima Centro", "San Isidro", "Miraflores"],
    },
  });

  const customer = await prisma.customer.create({
    data: {
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
      role: "USER",
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
      status: "ESPERANDO_PAGO",
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
      status: "PENDIENTE",
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
      status: "PEDIDO_REGISTRADO",
    },
  });

  console.log("Seed completado", {
    company: company.slug,
    adminPhone: defaultAdminPhone,
    superadminPhone,
    whatsappAccount: whatsappConfig.account,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
