import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

function getProviderFailureReason(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const body = payload as {
    status?: number;
    message?: string;
    data?: unknown;
  };

  if (typeof body.status === "number" && body.status >= 400) {
    return body.message ?? "El proveedor devolvio un estado de error.";
  }

  if (body.data === false) {
    return body.message ?? "El proveedor indico que la prueba no fue exitosa.";
  }

  return null;
}

export async function getWhatsappConfig(companyId: string) {
  return prisma.whatsappConfig.findUnique({ where: { companyId } });
}

export async function upsertWhatsappConfig(companyId: string, data: {
  apiUrl: string;
  secret: string;
  account: string;
  isActive: boolean;
}) {
  return prisma.whatsappConfig.upsert({
    where: { companyId },
    update: data,
    create: {
      companyId,
      ...data,
    },
  });
}

export async function testWhatsappConnection(data: {
  apiUrl: string;
  secret: string;
  account: string;
  recipient: string;
  message: string;
}) {
  const formData = new FormData();
  formData.append("secret", data.secret);
  formData.append("account", data.account);
  formData.append("recipient", data.recipient);
  formData.append("type", "text");
  formData.append("message", data.message);

  let response: Response;

  try {
    response = await fetch(data.apiUrl, {
      method: "POST",
      body: formData,
    });
  } catch (error) {
    throw new AppError(
      error instanceof Error ? `No se pudo conectar con la API de WhatsApp: ${error.message}` : "No se pudo conectar con la API de WhatsApp",
      502,
    );
  }

  const rawText = await response.text();
  let parsedBody: unknown = null;

  try {
    parsedBody = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsedBody = rawText;
  }

  if (!response.ok) {
    throw new AppError("La API de WhatsApp respondio con error durante la prueba de conexion", 502, parsedBody);
  }

  const providerFailureReason = getProviderFailureReason(parsedBody);
  if (providerFailureReason) {
    throw new AppError(
      `La prueba no fue aceptada por el proveedor: ${providerFailureReason}. Revisa tu configuracion y el numero de prueba.`,
      502,
      parsedBody,
    );
  }

  return {
    success: true,
    statusCode: response.status,
    message: "Conexion verificada y mensaje de prueba enviado correctamente.",
    providerResponse: parsedBody,
  };
}
