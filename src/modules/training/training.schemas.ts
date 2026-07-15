import { z } from "zod";

// ---------------------------------------------------------------------------
// Recursos de capacitación globales (superadmin). Validación por tipo:
// YOUTUBE exige URL de YouTube normalizable; LINK exige URL http(s);
// PDF/VIDEO exigen storagePath bajo `training/` (subido previamente).
// ---------------------------------------------------------------------------

export const trainingResourceTypeSchema = z.enum(["PDF", "VIDEO", "YOUTUBE", "LINK"]);

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extrae el videoId de una URL de YouTube (watch, youtu.be, shorts, embed, live). */
export function extractYoutubeId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, "").toLowerCase();
  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") {
      candidate = url.searchParams.get("v");
    } else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) {
      candidate = parts[1] ?? null;
    }
  }
  return candidate && YOUTUBE_ID_RE.test(candidate) ? candidate : null;
}

/** Normaliza cualquier URL de YouTube válida a su forma canónica watch?v=ID. */
export function normalizeYoutubeUrl(raw: string): string | null {
  const id = extractYoutubeId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeTrainingPath(storagePath: string): boolean {
  const normalized = storagePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith("training/") && !normalized.includes("..");
}

export const trainingResourceInputSchema = z
  .object({
    title: z.string().trim().min(2, "Título muy corto").max(120),
    description: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
    type: trainingResourceTypeSchema,
    url: z.string().trim().max(2000).nullish().transform((v) => (v ? v : null)),
    storagePath: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
    mimeType: z.string().trim().max(120).nullish().transform((v) => (v ? v : null)),
    size: z.coerce.number().int().nonnegative().nullish().transform((v) => (v ?? null)),
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
    isActive: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.type === "YOUTUBE") {
      if (!data.url || !normalizeYoutubeUrl(data.url)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "URL de YouTube inválida" });
      }
    } else if (data.type === "LINK") {
      if (!data.url || !isHttpUrl(data.url)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "URL inválida (usa http/https)" });
      }
    } else {
      // PDF | VIDEO: archivo subido previamente por /upload
      if (!data.storagePath || !isSafeTrainingPath(data.storagePath)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["storagePath"],
          message: "Falta el archivo subido (storagePath inválido)",
        });
      }
    }
  })
  .transform((data) => ({
    ...data,
    // Canonicaliza YouTube y limpia el campo que no aplica según el tipo.
    url: data.type === "YOUTUBE" ? normalizeYoutubeUrl(data.url ?? "") : data.type === "LINK" ? data.url : null,
    storagePath: data.type === "PDF" || data.type === "VIDEO" ? data.storagePath : null,
    mimeType: data.type === "PDF" || data.type === "VIDEO" ? data.mimeType : null,
    size: data.type === "PDF" || data.type === "VIDEO" ? data.size : null,
  }));

export type TrainingResourceInput = z.infer<typeof trainingResourceInputSchema>;

export const trainingIdParamsSchema = z.object({
  id: z.string().uuid(),
});
