import { z } from "zod";

export const groupIdParams = z.object({ id: z.string().uuid() });
export const customerIdParams = z.object({ customerId: z.string().uuid() });

export const groupMessageParams = z.object({ id: z.string().uuid(), mid: z.string().uuid() });

// Chat del grupo.
export const groupChatSchema = z.object({ enabled: z.boolean() });

export const groupInfoQuery = z.object({ refresh: z.enum(["0", "1"]).optional() });

export const groupMessagesQuery = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  starred: z.enum(["0", "1"]).optional(),
});

export const groupSendSchema = z
  .object({
    text: z.string().max(4000).optional(),
    mediaUrl: z.string().url().max(2000).optional(),
    mediaKind: z.enum(["image", "video", "audio", "document", "sticker"]).optional(),
    fileName: z.string().trim().max(200).optional(),
    quoteMessageId: z.string().uuid().optional(),
    mentions: z.array(z.string().trim().regex(/^\+?\d{6,16}$/)).max(50).optional(),
    poll: z
      .object({
        question: z.string().trim().min(1).max(255),
        options: z.array(z.string().trim().min(1).max(100)).min(2).max(12),
        selectable: z.number().int().min(1).max(12).optional(),
      })
      .optional(),
  })
  .refine((v) => Boolean(v.text?.trim()) || Boolean(v.mediaUrl) || Boolean(v.poll), { message: "El mensaje está vacío." });

export const groupStarSchema = z.object({ starred: z.boolean() });

// Pseudo-números LID incluidos (13 a 16 dígitos): no se validan como E.164.
export const removeParticipantsSchema = z.object({
  phones: z.array(z.string().trim().regex(/^\+?\d{6,16}$/)).min(1).max(50),
});

export const saveGroupSchema = z.object({
  gid: z.string().trim().min(5).max(120).regex(/@g\.us$/, "Identificador de grupo inválido"),
  name: z.string().trim().min(1).max(120),
});

export const listMembersQuery = z.object({
  filter: z.enum(["agregados", "invitados", "pendientes", "enEspera", "fallidos", "cancelados"]).optional(),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// Agregar: siempre por clientes elegidos (uno o varios). dryRun solo cuenta.
// strict: un productId (lote de compradores, retirado) responde 400 en vez de ignorarse.
export const addToGroupSchema = z
  .object({
    customerIds: z.array(z.string().uuid()).min(1).max(500),
    dryRun: z.boolean().optional(),
  })
  .strict();

// Mensaje que acompaña la invitación del grupo ("" o null = apagado).
export const groupInviteMessageSchema = z.object({
  message: z.string().max(1000).nullable(),
});

// Ritmo de altas del negocio (mismos límites que GROUP_PACING_LIMITS).
export const groupPacingSchema = z
  .object({
    perMinute: z.number().int().min(1).max(5).optional(),
    perHour: z.number().int().min(1).max(120).optional(),
    perDay: z.number().int().min(1).max(1000).optional(),
  })
  .refine((v) => v.perMinute !== undefined || v.perHour !== undefined || v.perDay !== undefined, {
    message: "Indica al menos un valor del ritmo.",
  });

export const retryMembersSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});
