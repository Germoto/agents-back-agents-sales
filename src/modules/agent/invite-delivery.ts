/**
 * Puente entre el seguimiento de entrega y la cola de grupos: cuando el gateway marca
 * como fallido el mensaje de invitación con el link del grupo, el miembro deja de
 * figurar como «Invitado». Import dinámico para no cruzar módulos en la carga.
 */

/** Origen de los mensajes de invitación a un grupo (rawPayload.source). */
export const GROUP_INVITE_SOURCE = "wa-group-invite";

/** Grupo del mensaje de invitación; `undefined` si el mensaje no es una invitación. */
export function inviteGroupOf(rawPayload: unknown): string | null | undefined {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return undefined;
  const p = rawPayload as Record<string, unknown>;
  // El mensaje que acompaña a la tarjeta de WhatsApp («companion») no es la invitación.
  if (p.source !== GROUP_INVITE_SOURCE || p.companion) return undefined;
  return typeof p.groupId === "string" && p.groupId ? p.groupId : null;
}

/** Avisa a la cola de grupos que un mensaje no se entregó. Nunca lanza. */
export async function onMessageDeliveryFailed(m: { companyId: string; customerId: string; rawPayload: unknown }): Promise<void> {
  const groupId = inviteGroupOf(m.rawPayload);
  if (groupId === undefined) return;
  try {
    const { markInviteLinkFailed } = await import("../whatsapp-groups/whatsapp-groups.service");
    await markInviteLinkFailed(m.companyId, m.customerId, groupId);
  } catch (err) {
    console.warn(`[wa-groups] no se pudo marcar la invitación fallida (cliente ${m.customerId}): ${err instanceof Error ? err.message : err}`);
  }
}
