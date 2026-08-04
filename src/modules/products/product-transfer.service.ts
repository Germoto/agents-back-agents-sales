/**
 * Exportar / importar el catálogo de productos como ZIP autocontenido
 * (manifest.json + media/ con los binarios).
 *
 * Por qué ZIP y no JSON con URLs: borrar un producto hace unlink FÍSICO de sus
 * archivos (safeUnlinkStorage), así que compartir rutas entre origen y destino
 * dejaría media rota. El import siempre COPIA los binarios a
 * products/<companyIdDestino>/ con nombres nuevos y reescribe todas las URLs.
 *
 * El import es en dos fases (analizar → confirmar) para poder mostrar un
 * preview en el panel antes de tocar nada.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { Response } from "express";
import archiver from "archiver";
import * as unzipper from "unzipper";
import { BusinessVertical, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";
import { mapAdminProduct, productRelations } from "../../lib/product";
import { productBodySchema } from "./products.schemas";
import { createProduct } from "./products.service";
import { manifestSchema, type TransferManifest } from "./product-transfer.schemas";

export const MANIFEST_FORMAT = "flowapp-products-export";
export const MANIFEST_VERSION = 1;

const uploadsRoot = () => path.resolve(process.cwd(), env.UPLOAD_DIR);

/** Directorio temporal de ZIPs subidos (dentro de uploads/ para compartir volumen). */
export const importTmpDir = () => path.join(uploadsRoot(), "tmp", "product-imports");

// ---------------------------------------------------------------------------
// Utilidades de media
// ---------------------------------------------------------------------------

/** Prefijo de las URLs de media propias de una empresa. */
function companyMediaPrefix(companyId: string): string {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/uploads/products/${companyId}/`;
}

/** URL absoluta → storagePath relativo ("products/<cid>/<file>") si es media propia de la empresa; null si no. */
function urlToStoragePath(url: string, companyId: string): string | null {
  const prefix = companyMediaPrefix(companyId);
  if (!url.startsWith(prefix)) return null;
  const rel = `products/${companyId}/${url.slice(prefix.length)}`;
  // Mismas reglas que ensureBelongsToCompany: sin traversal, dentro de la empresa.
  if (rel.includes("..") || rel.includes("//")) return null;
  return rel;
}

/**
 * Recorre recursivamente el producto serializado y aplica `fn` a cada string.
 * Si `fn` devuelve un string, lo reemplaza. Cubre de una vez files[].url,
 * presentationMessageMediaUrl, followups, crossSellPitchMediaUrl,
 * reminderConfig y cualquier JSON (verticalData) con URLs embebidas.
 */
function walkStrings(value: unknown, fn: (s: string) => string | void): unknown {
  if (typeof value === "string") {
    const out = fn(value);
    return out === undefined ? value : out;
  }
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkStrings(v, fn);
    }
    return out;
  }
  return value;
}

/** Extensión saneada de un storagePath (mismo criterio que upload.middleware). */
function safeExtension(storagePath: string): string {
  const ext = path.extname(storagePath).replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  return ext && ext.length <= 10 ? ext : ".bin";
}

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

export async function exportProducts(companyId: string, res: Response): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true, vertical: true },
  });
  if (!company) throw new AppError("Empresa no encontrada", 404);

  const rows = await prisma.product.findMany({
    where: { companyId },
    include: productRelations,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (!rows.length) throw new AppError("No hay productos para exportar", 400);

  const products = rows.map(mapAdminProduct) as Array<Record<string, unknown>>;

  // crossSell se remapea por slug en el destino (los ids no viajan).
  const slugById = new Map(rows.map((p) => [p.id, p.slug]));
  for (const p of products) {
    const dd = p.digitalDelivery as { crossSellProductId?: string | null } & Record<string, unknown> | null;
    if (dd?.crossSellProductId) {
      dd.crossSellProductSlug = slugById.get(dd.crossSellProductId) ?? null;
    }
  }

  // Recolectar TODA la media propia referenciada (deep-walk sobre lo serializado).
  const mediaUrls = new Set<string>();
  walkStrings(products, (s) => {
    if (urlToStoragePath(s, companyId)) mediaUrls.add(s);
  });

  const media: TransferManifest["media"] = {};
  const missingMedia: string[] = [];
  for (const url of mediaUrls) {
    const storagePath = urlToStoragePath(url, companyId)!;
    const abs = path.resolve(uploadsRoot(), storagePath);
    try {
      const stat = await fsp.stat(abs);
      media[url] = { zipPath: `media/${path.basename(storagePath)}`, size: stat.size };
    } catch {
      missingMedia.push(url);
    }
  }

  const manifest: TransferManifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    vertical: company.vertical,
    sourceCompany: { name: company.name },
    products,
    media,
    missingMedia,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `productos-${company.vertical.toLowerCase()}-${stamp}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  // Nivel 1: imágenes/videos ya vienen comprimidos; prima el throughput.
  const archive = archiver("zip", { zlib: { level: 1 } });
  archive.on("error", (err) => res.destroy(err));
  archive.pipe(res);
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  for (const [url, entry] of Object.entries(media)) {
    const storagePath = urlToStoragePath(url, companyId)!;
    archive.file(path.resolve(uploadsRoot(), storagePath), { name: entry.zipPath });
  }
  await archive.finalize();
}

// ---------------------------------------------------------------------------
// IMPORT — fase 1: analizar (preview)
// ---------------------------------------------------------------------------

interface PendingImport {
  companyId: string;
  zipPath: string;
  manifest: TransferManifest;
  expiresAt: number;
}

// Tokens de import en memoria. Supone proceso único (hoy: un solo node);
// si algún día hay múltiples workers, mover a tabla o Redis.
const pendingImports = new Map<string, PendingImport>();
const IMPORT_TTL_MS = 30 * 60 * 1000;

function sweepExpired(): void {
  const now = Date.now();
  for (const [token, entry] of pendingImports) {
    if (entry.expiresAt < now) {
      pendingImports.delete(token);
      fsp.unlink(entry.zipPath).catch(() => undefined);
    }
  }
}

export async function analyzeImport(companyId: string, zipPath: string) {
  sweepExpired();

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { vertical: true },
  });
  if (!company) throw new AppError("Empresa no encontrada", 404);

  let directory: unzipper.CentralDirectory;
  try {
    directory = await unzipper.Open.file(zipPath);
  } catch {
    await fsp.unlink(zipPath).catch(() => undefined);
    throw new AppError("El archivo no es un ZIP válido", 400);
  }

  // Anti zip-bomb: el tamaño descomprimido declarado no puede exceder por mucho el límite.
  const uncompressed = directory.files.reduce((acc, f) => acc + (f.uncompressedSize ?? 0), 0);
  if (uncompressed > env.MAX_IMPORT_MB * 1024 * 1024 * 2) {
    await fsp.unlink(zipPath).catch(() => undefined);
    throw new AppError("El archivo excede el tamaño permitido", 413);
  }

  const manifestEntry = directory.files.find((f) => f.path === "manifest.json");
  if (!manifestEntry) {
    await fsp.unlink(zipPath).catch(() => undefined);
    throw new AppError("El archivo no es un export de productos de FlowApp (falta manifest.json)", 400);
  }

  let manifest: TransferManifest;
  try {
    const raw = JSON.parse((await manifestEntry.buffer()).toString("utf8"));
    manifest = manifestSchema.parse(raw) as TransferManifest;
  } catch {
    await fsp.unlink(zipPath).catch(() => undefined);
    throw new AppError("El manifest del archivo está corrupto o es de una versión no soportada", 400);
  }

  // Regla del feature: solo se importa en el MISMO rubro en que se exportó.
  if (manifest.vertical !== company.vertical) {
    await fsp.unlink(zipPath).catch(() => undefined);
    throw new AppError(
      `Este archivo fue exportado de un negocio del rubro ${manifest.vertical} y tu empresa es del rubro ${company.vertical}. Solo puedes importarlo en el mismo rubro.`,
      400,
      { code: "VERTICAL_MISMATCH" },
    );
  }

  const token = crypto.randomBytes(24).toString("hex");
  pendingImports.set(token, {
    companyId,
    zipPath,
    manifest,
    expiresAt: Date.now() + IMPORT_TTL_MS,
  });

  const mediaEntries = Object.values(manifest.media);
  return {
    uploadToken: token,
    vertical: manifest.vertical,
    sourceCompany: manifest.sourceCompany?.name ?? null,
    exportedAt: manifest.exportedAt,
    productCount: manifest.products.length,
    productNames: manifest.products.map((p) => String((p as { name?: unknown }).name ?? "Producto")),
    mediaCount: mediaEntries.length,
    mediaTotalBytes: mediaEntries.reduce((acc, m) => acc + (m.size ?? 0), 0),
    missingMediaCount: manifest.missingMedia?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// IMPORT — fase 2: confirmar
// ---------------------------------------------------------------------------

/** Slug único dentro de la empresa y del lote: base, base-2, base-3… */
function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  let i = 2;
  while (taken.has(slug)) slug = `${base}-${i++}`;
  taken.add(slug);
  return slug;
}

export async function confirmImport(companyId: string, token: string) {
  sweepExpired();
  const pending = pendingImports.get(token);
  // Scoping: el token es de un solo uso y solo vale para la empresa que lo creó.
  if (!pending || pending.companyId !== companyId) {
    throw new AppError("La importación expiró o no es válida. Vuelve a subir el archivo.", 404);
  }
  pendingImports.delete(token);

  const { manifest, zipPath } = pending;
  const warnings: string[] = [];
  const copiedPaths: string[] = [];

  try {
    const directory = await unzipper.Open.file(zipPath).catch(() => {
      throw new AppError("El archivo temporal ya no está disponible. Vuelve a subirlo.", 410);
    });
    const zipEntries = new Map(directory.files.map((f) => [f.path, f]));

    // --- Copia de media: cada URL vieja → archivo NUEVO bajo products/<destino>/ ---
    // El nombre destino SIEMPRE lo genera el servidor; los zipPath del manifest
    // jamás se usan como ruta de escritura (anti path-traversal).
    const destDir = path.join(uploadsRoot(), "products", companyId);
    await fsp.mkdir(destDir, { recursive: true });

    const urlMap = new Map<string, { newUrl: string; newStoragePath: string }>();
    const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");

    for (const [oldUrl, entry] of Object.entries(manifest.media)) {
      const ext = safeExtension(entry.zipPath);
      const newName = `${crypto.randomUUID()}${ext}`;
      const newStoragePath = `products/${companyId}/${newName}`;
      const destAbs = path.join(destDir, newName);

      const zipEntry = zipEntries.get(entry.zipPath);
      if (zipEntry) {
        await new Promise<void>((resolve, reject) => {
          zipEntry
            .stream()
            .pipe(fs.createWriteStream(destAbs))
            .on("finish", () => resolve())
            .on("error", reject);
        });
      } else {
        // Fallback: si la media falta en el ZIP pero la URL apunta a ESTE mismo
        // servidor y el archivo aún existe, se copia del disco.
        const localRel = oldUrl.startsWith(`${base}/uploads/`) ? oldUrl.slice(`${base}/uploads/`.length) : null;
        const localAbs =
          localRel && !localRel.includes("..") ? path.resolve(uploadsRoot(), localRel) : null;
        if (localAbs && fs.existsSync(localAbs)) {
          await fsp.copyFile(localAbs, destAbs);
        } else {
          warnings.push(`No se pudo recuperar un archivo multimedia (${path.basename(entry.zipPath)}); el campo quedó vacío.`);
          continue;
        }
      }
      copiedPaths.push(destAbs);
      urlMap.set(oldUrl, { newUrl: `${base}/uploads/${newStoragePath}`, newStoragePath });
    }
    for (const missing of manifest.missingMedia ?? []) {
      warnings.push(`El export ya venía sin un archivo multimedia (${path.basename(missing)}).`);
    }

    // --- Slugs únicos: contra la BD del destino y contra el propio lote ---
    const existing = await prisma.product.findMany({ where: { companyId }, select: { slug: true } });
    const taken = new Set(existing.map((p) => p.slug));

    const results: Array<{ name: string; slug: string; status: "ok" | "error"; error?: string }> = [];
    const createdIdBySourceSlug = new Map<string, string>();

    for (const raw of manifest.products) {
      const source = raw as Record<string, unknown>;
      const sourceName = String(source.name ?? "Producto");
      const sourceSlug = String(source.slug ?? "producto");
      try {
        // 1) Reescritura de URLs (deep-walk) + limpieza de campos no portables.
        const rewritten = walkStrings(source, (s) => {
          const mapped = urlMap.get(s);
          if (mapped) return mapped.newUrl;
          // Media propia del origen que no se pudo recuperar → campo vacío.
          if (manifest.media[s] || manifest.missingMedia?.includes(s)) return "";
          return undefined;
        }) as Record<string, unknown>;

        const slug = uniqueSlug(sourceSlug, taken);

        // files[]: storagePath nuevo (lookup por la URL YA reescrita) y sin id.
        const newFiles = (Array.isArray(rewritten.files) ? (rewritten.files as Array<Record<string, unknown>>) : [])
          .filter((f) => {
            const url = String(f.url ?? "");
            return url && [...urlMap.values()].some((m) => m.newUrl === url);
          })
          .map((f, index) => {
            const url = String(f.url);
            const mapped = [...urlMap.values()].find((m) => m.newUrl === url)!;
            const type = ["IMAGE", "PDF", "VIDEO", "AUDIO", "OTHER"].includes(String(f.type))
              ? (String(f.type) as "IMAGE" | "PDF" | "VIDEO" | "AUDIO" | "OTHER")
              : "OTHER";
            return {
              type,
              url,
              storagePath: mapped.newStoragePath,
              originalName: String(f.originalName ?? ""),
              extension: String(f.extension ?? ""),
              mimeType: String(f.mimeType ?? ""),
              size: Number(f.size ?? 0),
              description: String(f.description ?? ""),
              sortOrder: index,
              showInPresentation: f.showInPresentation !== false,
            };
          });

        const dd = (rewritten.digitalDelivery ?? null) as Record<string, unknown> | null;
        const digitalDelivery = dd
          ? {
              link: String(dd.link ?? ""),
              instructions: String(dd.instructions ?? ""),
              assignmentMode: (["STATIC", "POOL_AUTO", "MANUAL"] as const).includes(
                dd.assignmentMode as "STATIC",
              )
                ? (dd.assignmentMode as "STATIC" | "POOL_AUTO" | "MANUAL")
                : "STATIC",
              followupMessages: Array.isArray(dd.followupMessages) ? dd.followupMessages : [],
              followupMessage: String(dd.followupMessage ?? ""),
              followupMediaUrl: String(dd.followupMediaUrl ?? ""),
              followupMediaType: String(dd.followupMediaType ?? ""),
              crossSellPitch: String(dd.crossSellPitch ?? ""),
              crossSellPitchMediaUrl: String(dd.crossSellPitchMediaUrl ?? ""),
              crossSellPitchMediaType: String(dd.crossSellPitchMediaType ?? ""),
              // Referencias de OTRA empresa: crossSell se remapea después por slug;
              // ids de CRM/columnas/tags se limpian SIEMPRE.
              crossSellProductId: null,
              onSaleCrmId: null,
              onSaleCrmColumnId: null,
              onSaleTagIds: [],
              onSaleRemoveTagIds: [],
              onPresentationCrmId: null,
              onPresentationCrmColumnId: null,
              onPresentationTagIds: [],
              onPresentationRemoveTagIds: [],
              onPaymentCrmId: null,
              onPaymentCrmColumnId: null,
              onPaymentTagIds: [],
              onPaymentRemoveTagIds: [],
            }
          : null;

        const pd = (rewritten.physicalDelivery ?? null) as Record<string, unknown> | null;
        const toOrdered = (arr: unknown) =>
          (Array.isArray(arr) ? arr : [])
            .map((v, i) => ({ value: String(v ?? "").trim(), sortOrder: i }))
            .filter((x) => x.value);
        const toQa = (arr: unknown) =>
          (Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [])
            .map((q, i) => ({
              question: String(q.question ?? "").trim(),
              answer: String(q.answer ?? "").trim(),
              sortOrder: i,
            }))
            .filter((q) => q.question && q.answer);

        const candidate = {
          slug,
          active: rewritten.active !== false,
          showInCatalog: rewritten.showInCatalog !== false,
          pauseHumanAfterSale: rewritten.pauseHumanAfterSale === true,
          productType: rewritten.productType === "PHYSICAL" ? "PHYSICAL" : "DIGITAL",
          name: sourceName,
          price: String(rewritten.price ?? "0"),
          regularPrice: rewritten.regularPrice == null ? null : String(rewritten.regularPrice),
          stock: rewritten.stock == null ? null : Number(rewritten.stock),
          durationMin: rewritten.durationMin == null ? null : Number(rewritten.durationMin),
          slotCapacity: rewritten.slotCapacity == null ? null : Number(rewritten.slotCapacity),
          bookingLeadMinutes: rewritten.bookingLeadMinutes == null ? null : Number(rewritten.bookingLeadMinutes),
          bookingHorizonDays: rewritten.bookingHorizonDays == null ? null : Number(rewritten.bookingHorizonDays),
          shortDescription: String(rewritten.shortDescription ?? ""),
          fullDescription: String(rewritten.fullDescription ?? ""),
          presentationMessage: rewritten.presentationMessage == null ? null : String(rewritten.presentationMessage),
          presentationMessageMediaUrl: String(rewritten.presentationMessageMediaUrl ?? ""),
          presentationMessageMediaType: String(rewritten.presentationMessageMediaType ?? ""),
          presentationFollowups: Array.isArray(rewritten.presentationFollowups)
            ? rewritten.presentationFollowups
            : [],
          deliveryMethod: rewritten.deliveryMethod == null ? null : String(rewritten.deliveryMethod),
          support: rewritten.support == null ? null : String(rewritten.support),
          attributes: (rewritten.attributes as Record<string, string> | null) ?? null,
          category: rewritten.category == null ? null : String(rewritten.category),
          verticalData: (rewritten.verticalData as Record<string, unknown> | null) ?? null,
          reminderConfig: (rewritten.reminderConfig as Record<string, unknown> | null) ?? null,
          aliases: (Array.isArray(rewritten.aliases) ? rewritten.aliases : [])
            .map((a) => String(a ?? "").trim())
            .filter(Boolean),
          benefits: toOrdered(rewritten.benefits),
          includes: toOrdered(rewritten.includes),
          bonuses: toOrdered(rewritten.bonuses),
          faqs: toQa(rewritten.faqs),
          objections: toQa(rewritten.objections),
          files: newFiles,
          digitalDelivery,
          physicalDelivery: pd
            ? {
                requiresAddress: pd.requiresAddress !== false,
                deliveryCost: pd.deliveryCost == null ? null : String(pd.deliveryCost),
                deliveryTime: pd.deliveryTime == null ? null : String(pd.deliveryTime),
                pickupAvailable: pd.pickupAvailable === true,
                deliveryAreas: (Array.isArray(pd.deliveryAreas) ? pd.deliveryAreas : [])
                  .map((a) => String(a ?? "").trim())
                  .filter(Boolean),
              }
            : null,
          variants: (Array.isArray(rewritten.variants) ? (rewritten.variants as Array<Record<string, unknown>>) : [])
            .map((v, i) => ({
              name: String(v.name ?? "").trim(),
              options: (Array.isArray(v.options) ? v.options : []).map((o) => String(o ?? "")),
              sortOrder: i,
            }))
            .filter((v) => v.name),
        };

        // 2) La validación fuerte la hace el MISMO schema del panel: cualquier
        // manifest corrupto falla aquí con un error legible por producto.
        const payload = productBodySchema.parse(candidate);
        const created = await createProduct(companyId, payload as Parameters<typeof createProduct>[1]);
        createdIdBySourceSlug.set(sourceSlug, created.id);
        results.push({ name: sourceName, slug, status: "ok" });
      } catch (err) {
        results.push({
          name: sourceName,
          slug: sourceSlug,
          status: "error",
          error: err instanceof Error ? err.message.slice(0, 300) : "Error desconocido",
        });
      }
    }

    // --- Segunda pasada: remapear crossSell por slug DENTRO del lote ---
    for (const raw of manifest.products) {
      const source = raw as { slug?: unknown; digitalDelivery?: { crossSellProductSlug?: unknown } | null };
      const sourceSlug = String(source.slug ?? "");
      const crossSlug = source.digitalDelivery?.crossSellProductSlug;
      const productId = createdIdBySourceSlug.get(sourceSlug);
      if (!productId || typeof crossSlug !== "string" || !crossSlug) continue;
      const targetId = createdIdBySourceSlug.get(crossSlug);
      if (!targetId) {
        warnings.push(`El cross-sell de "${sourceSlug}" apuntaba a un producto que no vino en el archivo; quedó sin configurar.`);
        continue;
      }
      await prisma.digitalDelivery
        .updateMany({ where: { productId }, data: { crossSellProductId: targetId } })
        .catch(() => undefined);
    }

    const imported = results.filter((r) => r.status === "ok").length;
    // Si NADA se importó, las copias de media quedaron huérfanas: se limpian.
    if (imported === 0) {
      for (const abs of copiedPaths) await fsp.unlink(abs).catch(() => undefined);
    }
    return {
      total: results.length,
      imported,
      failed: results.length - imported,
      warnings,
      products: results,
    };
  } finally {
    await fsp.unlink(zipPath).catch(() => undefined);
  }
}
