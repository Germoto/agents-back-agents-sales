/**
 * Búsqueda aproximada sobre el índice en memoria (drive-index.service) con
 * fallback en vivo (lib/google-drive) cuando el índice no existe o es parcial.
 * Sin importar mayúsculas, tildes, orden de palabras ni errores de tipeo pequeños.
 */

import {
  searchDrive,
  browseFolder,
  listFolder,
  fuzzyScore,
  driveViewLink,
  driveFileKind,
  deliveryDriveRefs,
  DRIVE_ATTACH_MAX_BYTES,
  type DriveEntry,
  type DriveRef,
} from "../../lib/google-drive";
import { ensureIndex, getIndex, isBuilding, indexSummary, type IndexEntry, type ProductDriveIndex, type DriveProductLike } from "./drive-index.service";

export interface SearchOpts {
  offset?: number;
  limit?: number;
  /** Solo archivos (sin carpetas). */
  filesOnly?: boolean;
}

export interface SearchOutcome {
  entries: DriveEntry[];
  total: number;
  offset: number;
  nextOffset: number | null;
  /** "indice" = vino del índice en memoria; "vivo" = consulta directa a Drive. */
  fuente: "indice" | "vivo" | "indice+vivo";
  indice: ReturnType<typeof indexSummary>;
  inaccessible: string[];
}

function page<T>(items: T[], offset: number, limit: number): { slice: T[]; nextOffset: number | null } {
  const slice = items.slice(offset, offset + limit);
  return { slice, nextOffset: offset + limit < items.length ? offset + limit : null };
}

/** Puntúa y ordena las entradas del índice; archivos antes que carpetas al empatar. */
export function rankIndex(idx: ProductDriveIndex, query: string, filesOnly = false): IndexEntry[] {
  const scored: Array<{ e: IndexEntry; s: number }> = [];
  for (const e of idx.entries) {
    if (filesOnly && e.isFolder) continue;
    const s = fuzzyScore(query, e.name, e.pathNorm, e.words);
    if (s > 0) scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || Number(a.e.isFolder) - Number(b.e.isFolder) || a.e.depth - b.e.depth || a.e.name.localeCompare(b.e.name));
  return scored.map((x) => x.e);
}

/**
 * Busca `query` en la entrega del producto: índice si existe (y dispara su
 * construcción/actualización si hace falta); en vivo si no hay índice; ambos si el
 * índice es parcial y trajo pocos resultados.
 */
export async function searchProductDrive(product: DriveProductLike, query: string, opts: SearchOpts = {}): Promise<SearchOutcome> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
  const idx = ensureIndex(product);
  const refs = deliveryDriveRefs(product.digitalDelivery);
  const inaccessible: string[] = [];

  if (idx && idx.entries.length) {
    let ranked: DriveEntry[] = rankIndex(idx, query, opts.filesOnly);
    let fuente: SearchOutcome["fuente"] = "indice";
    if (idx.truncated && ranked.length < 3) {
      // Carpetas que quedaron fuera del tope: buscar en vivo solo en las que coinciden por etiqueta.
      try {
        const live = await searchDrive(idx.rootRefs.length ? idx.rootRefs : refs, query, { limit: 20 });
        const seen = new Set(ranked.map((e) => e.id));
        for (const e of live.entries) {
          if (seen.has(e.id) || (opts.filesOnly && e.isFolder)) continue;
          ranked.push(e);
        }
        inaccessible.push(...live.inaccessible);
        fuente = "indice+vivo";
      } catch {
        /* el índice ya respondió algo; el vivo es best-effort */
      }
    }
    const { slice, nextOffset } = page(ranked, offset, limit);
    return { entries: slice, total: ranked.length, offset, nextOffset, fuente, indice: indexSummary(product.id), inaccessible };
  }

  const live = await searchDrive(refs, query, { limit: 60 });
  const all = opts.filesOnly ? live.entries.filter((e) => !e.isFolder) : live.entries;
  const { slice, nextOffset } = page(all, offset, limit);
  return { entries: slice, total: all.length, offset, nextOffset, fuente: "vivo", indice: indexSummary(product.id), inaccessible: live.inaccessible };
}

/** Lista una carpeta (índice si la conoce; si no, en vivo), con filtro y paginación. */
export async function browseProductFolder(
  product: DriveProductLike,
  folderId: string,
  opts: SearchOpts & { query?: string } = {},
): Promise<{ folder: DriveEntry | null; entries: DriveEntry[]; total: number; offset: number; nextOffset: number | null; fuente: "indice" | "vivo"; truncated: boolean }> {
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const idx = ensureIndex(product);
  const known = idx?.byId.get(folderId);
  if (idx && known && known.isFolder && (idx.children.get(folderId)?.length || !idx.unindexedFolderIds.includes(folderId))) {
    let items: DriveEntry[] = idx.children.get(folderId) ?? [];
    if (opts.query?.trim()) {
      items = items
        .map((e) => ({ e, s: fuzzyScore(opts.query!, e.name, e.name, (e as IndexEntry).words) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.e);
    }
    if (opts.filesOnly) items = items.filter((e) => !e.isFolder);
    const { slice, nextOffset } = page(items, offset, limit);
    return { folder: known, entries: slice, total: items.length, offset, nextOffset, fuente: "indice", truncated: false };
  }
  const r = await browseFolder(folderId, { query: opts.query, offset, limit, parentPath: known?.path });
  const entries = opts.filesOnly ? r.entries.filter((e) => !e.isFolder) : r.entries;
  return { folder: r.folder, entries, total: r.total, offset, nextOffset: offset + limit < r.total ? offset + limit : null, fuente: "vivo", truncated: r.truncated };
}

/**
 * UNA muestra (archivo suelto, nunca carpeta) del tema pedido: el mejor archivo que
 * coincide; si lo que coincide es una carpeta, un archivo de dentro (el más pequeño
 * que se pueda adjuntar, si no el primero). null si no hay nada.
 */
export async function pickSample(product: DriveProductLike, tema: string): Promise<{ file: DriveEntry; via: "archivo" | "carpeta"; folder?: DriveEntry } | null> {
  const files = await searchProductDrive(product, tema, { filesOnly: true, limit: 5 });
  if (files.entries.length) return { file: files.entries[0], via: "archivo" };
  const any = await searchProductDrive(product, tema, { limit: 5 });
  const folder = any.entries.find((e) => e.isFolder);
  if (!folder) return null;
  const inside = await browseProductFolder(product, folder.id, { filesOnly: true, limit: 100 });
  let candidates = inside.entries;
  if (!candidates.length) {
    // Carpeta de carpetas: bajar un nivel más.
    const sub = (await browseProductFolder(product, folder.id, { limit: 20 })).entries.filter((e) => e.isFolder);
    for (const s of sub) {
      const r = await browseProductFolder(product, s.id, { filesOnly: true, limit: 50 });
      if (r.entries.length) {
        candidates = r.entries;
        break;
      }
    }
  }
  if (!candidates.length) return null;
  const attachable = candidates
    .filter((e) => {
      const kind = driveFileKind(e);
      const max = DRIVE_ATTACH_MAX_BYTES[kind];
      return max && e.size != null && e.size <= max;
    })
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  return { file: attachable[0] ?? candidates[0], via: "carpeta", folder };
}

export { driveViewLink, listFolder, isBuilding, getIndex };
export type { DriveRef };
