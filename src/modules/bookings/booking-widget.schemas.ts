import { z } from "zod";

/** Config del widget de reservas (panel del tenant). */
export const updateBookingWidgetSchema = z.object({
  enabled: z.boolean().optional(),
  allowedOrigins: z.array(z.string().trim().min(1)).max(20).optional(),
  headline: z.string().trim().max(120).optional(),
  accentColor: z.string().trim().max(32).optional(),
  successMessage: z.string().trim().max(300).optional(),
  productIds: z.array(z.string().uuid()).max(50).optional(),
});

/** Reserva desde el widget (público). El WhatsApp es obligatorio: sin él no hay confirmación ni recordatorio. */
export const widgetBookSchema = z.object({
  token: z.string().min(8),
  productId: z.string().uuid(),
  startsAt: z.string().min(10),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(6).max(24),
  notes: z.string().trim().max(300).optional(),
  // Origen de la página que embebe (lo pasa el iframe): se valida contra los dominios permitidos.
  parentOrigin: z.string().trim().max(300).optional(),
});

export const widgetCancelSchema = z.object({
  token: z.string().min(8),
  bookingCode: z.string().trim().min(4).max(24),
  cancelToken: z.string().trim().min(8).max(64),
  parentOrigin: z.string().trim().max(300).optional(),
});

export type UpdateBookingWidgetBody = z.infer<typeof updateBookingWidgetSchema>;
export type WidgetBookBody = z.infer<typeof widgetBookSchema>;
export type WidgetCancelBody = z.infer<typeof widgetCancelSchema>;
