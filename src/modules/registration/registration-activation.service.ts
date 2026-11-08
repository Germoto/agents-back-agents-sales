import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { uniqueCompanySlug } from "../../lib/slug";
import { socketService, SOCKET_EVENTS } from "../../lib/socket";
import { issueSession } from "../auth/auth.service";
import { notifyPlatformAdmin } from "../platform-config/platform-notify.service";
import { getAutoActivateConfig, getTrialAiProvision } from "../platform-config/platform-config.service";
import { convertPreRegistration } from "./registration-admin.service";
import { superadminCompanyId } from "./registration.service";
import { newClientActivatedAdminEmail } from "./registration.emails";

// ---------------------------------------------------------------------------
// Registro en un solo paso: al verificar el correo, si el superadmin activó la
// opción, la cuenta se crea sola (slug generado, prueba gratis de N días, canal
// SMS Tools —pendiente si el proveedor falla— e IA de prueba si está encendida)
// y se devuelve la sesión para entrar directo al panel.
// ---------------------------------------------------------------------------

export type AutoActivationResult = {
  companyId: string;
  session: ReturnType<typeof issueSession> | null;
};

/** null = la activación automática está apagada (sigue el flujo manual). Lanza si falla. */
export async function autoActivatePreRegistration(id: string): Promise<AutoActivationResult | null> {
  const cfg = await getAutoActivateConfig();
  if (!cfg.enabled) return null;

  const prereg = await prisma.preRegistration.findUnique({ where: { id }, include: { plan: { select: { name: true } } } });
  if (!prereg || prereg.status !== "VERIFIED") return null;

  const slug = await uniqueCompanySlug(prereg.companyName, async (candidate) => {
    const clash = await prisma.company.findUnique({ where: { slug: candidate }, select: { id: true } });
    return !!clash;
  });
  const aiKey = await getTrialAiProvision();

  const client = await convertPreRegistration(id, {
    slug,
    forceTrial: true,
    trialDays: cfg.trialDays,
    whatsappProvider: "SMSTOOLS",
    smsToolsLazy: true,
    aiKey: aiKey ?? undefined,
    isActive: true,
  });

  const admin = await prisma.user.findFirst({ where: { companyId: client.id, role: "ADMIN" } });
  const session = admin ? issueSession(admin) : null;

  void notifyAdminClientActivated({
    companyName: prereg.companyName,
    fullName: prereg.fullName,
    email: prereg.email,
    phone: prereg.phone,
    planName: prereg.plan?.name ?? "Por definir",
    vertical: prereg.vertical,
    trialDays: cfg.trialDays,
    slug,
  }).catch((err) => console.warn("[registration] aviso de activación falló:", err instanceof Error ? err.message : err));

  return { companyId: client.id, session };
}

async function notifyAdminClientActivated(params: {
  companyName: string;
  fullName: string;
  email: string;
  phone: string;
  planName: string;
  vertical: string;
  trialDays: number;
  slug: string;
}): Promise<void> {
  const adminCompanyId = await superadminCompanyId().catch(() => null);
  if (adminCompanyId) {
    socketService.emitToCompany(adminCompanyId, SOCKET_EVENTS.PREREG_NEW, {
      companyName: params.companyName,
      planName: params.planName,
      activated: true,
    });
  }
  const consoleUrl = env.FRONTEND_URL ? `${env.FRONTEND_URL.replace(/\/$/, "")}/control-room-7m4x/clientes` : undefined;
  const mail = newClientActivatedAdminEmail({ ...params, consoleUrl });
  await notifyPlatformAdmin({
    subject: mail.subject,
    html: mail.html,
    text:
      `🟢 *Nuevo cliente activado*\n\n` +
      `Empresa: ${params.companyName} (${params.slug})\nContacto: ${params.fullName}\nTel: +${params.phone}\n` +
      `Plan de interés: ${params.planName}\nPrueba: ${params.trialDays} días\n\n` +
      `Míralo en el Control Room${consoleUrl ? `: ${consoleUrl}` : "."}`,
  });
}
