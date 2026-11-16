import { z } from "zod";

export const groupIdParams = z.object({ id: z.string().uuid() });
export const customerIdParams = z.object({ customerId: z.string().uuid() });

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

// Agregar: por clientes (uno o lote) o por compradores de un producto. dryRun solo cuenta.
export const addToGroupSchema = z
  .object({
    customerIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    productId: z.string().uuid().optional(),
    dryRun: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.customerIds?.length) !== Boolean(v.productId), {
    message: "Indica clientes o un producto (solo uno de los dos).",
  });

export const retryMembersSchema = z.object({
  memberIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});
