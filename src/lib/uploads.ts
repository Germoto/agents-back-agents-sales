/**
 * Acceso seguro a archivos de NUESTROS uploads en disco (UPLOAD_DIR).
 * Anti path-traversal: el path resuelto debe quedar dentro del UPLOAD_DIR y,
 * cuando se indica companyId, dentro de la carpeta de esa empresa.
 */

import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";

export interface ResolvedUpload {
  filePath: string;
  storagePath: string;
  fileName: string;
  extension: string;
  size: number;
}

function uploadRoot(): string {
  return path.resolve(process.cwd(), env.UPLOAD_DIR);
}

/** URL pública de un upload → storagePath relativo (o null si no es nuestra). */
export function storagePathFromUrl(url: string): string | null {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const prefix = `${base}/uploads/`;
  if (!url.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(url.slice(prefix.length).split("?")[0]);
  } catch {
    return null;
  }
}

/**
 * Resuelve un storagePath relativo a un archivo existente en disco. Con
 * `companyId`, exige que viva bajo products/<companyId>/ (archivos de producto).
 * Devuelve null si no existe, no es archivo o escapa del directorio permitido.
 */
export async function resolveOwnUpload(
  storagePath: string,
  opts: { companyId?: string } = {},
): Promise<ResolvedUpload | null> {
  const rel = storagePath.replace(/^\/+/, "");
  if (!rel) return null;
  const root = uploadRoot();
  const filePath = path.resolve(root, rel);
  if (!filePath.startsWith(root + path.sep)) return null;
  if (opts.companyId) {
    // Archivos de producto: públicos (products/<companyId>/) o privados (private/products/<companyId>/).
    const companyDir = path.resolve(root, "products", opts.companyId);
    const privateDir = path.resolve(root, "private", "products", opts.companyId);
    if (!filePath.startsWith(companyDir + path.sep) && !filePath.startsWith(privateDir + path.sep)) return null;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return {
      filePath,
      storagePath: rel,
      fileName: path.basename(filePath),
      extension: (path.extname(filePath).slice(1) || "").toLowerCase(),
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/** Lee el archivo completo a memoria (para adjuntos de correo). */
export async function readUpload(resolved: ResolvedUpload): Promise<Buffer> {
  return fs.readFile(resolved.filePath);
}

/** URL canónica de un archivo privado (sin token; se firma al entregar). */
export function privateDownloadUrl(fileId: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/public/dl/${fileId}`;
}

export function isPrivateStoragePath(storagePath: string): boolean {
  return storagePath.replace(/^\/+/, "").startsWith("private/products/");
}

/**
 * Mueve un archivo de producto entre la carpeta pública (products/<companyId>/)
 * y la privada (private/products/<companyId>/). Devuelve el storagePath nuevo o
 * null si no existe / no pertenece a la empresa. Mismo nombre de archivo.
 */
export async function moveProductFile(storagePath: string, companyId: string, toPrivate: boolean): Promise<string | null> {
  const resolved = await resolveOwnUpload(storagePath, { companyId });
  if (!resolved) return null;
  const alreadyPrivate = isPrivateStoragePath(resolved.storagePath);
  if (alreadyPrivate === toPrivate) return resolved.storagePath;
  const rel = toPrivate ? `private/products/${companyId}/${resolved.fileName}` : `products/${companyId}/${resolved.fileName}`;
  const dest = path.resolve(uploadRoot(), rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(resolved.filePath, dest);
  return rel;
}
