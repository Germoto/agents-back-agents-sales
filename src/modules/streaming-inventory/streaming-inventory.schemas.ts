import { z } from "zod";

const credentialFields = {
  optionLabel: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  profileName: z.string().nullable().optional(),
  pin: z.string().nullable().optional(),
  extra: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
};

export const createCredentialsSchema = z.object({
  productId: z.string().uuid(),
  items: z.array(z.object(credentialFields)).min(1),
});

export const updateCredentialSchema = z.object({
  ...credentialFields,
  status: z.enum(["AVAILABLE", "ASSIGNED", "DOWN", "DISABLED"]).optional(),
});

export const credentialIdParamsSchema = z.object({ id: z.string().uuid() });
export const listCredentialsQuerySchema = z.object({ productId: z.string().uuid().optional() });
