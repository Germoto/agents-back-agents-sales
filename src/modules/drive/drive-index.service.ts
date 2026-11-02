/**
 * Índice EN MEMORIA de las carpetas públicas de Google Drive de la entrega de cada
 * producto (decisión del dueño: nada se guarda en la base). Se construye por BFS
 * desde los links de digitalDelivery (instructions + followupMessages, docs de
 * Google expandidos), con tope de entradas y profundidad, y se intercambia de golpe
 * al terminar (nunca se ve un índice a medias). Se rehace al reiniciar, cada
 * DRIVE_INDEX_REFRESH_HOURS y cuando cambian los links de la entrega.
 */

import { env } from "../../config/env";
import {
  deliveryDriveRefs,
  expandDocRefs,
  listFolder,
  getFile,
  driveSearchEnabled,
  normalizeText,
  nameWords,
  DriveAccessError,
  type DriveRef,
  type DriveEntry,
} from "../../lib/google-drive";

export interface IndexEntry extends DriveEntry {
  /** Palabras normalizadas del nombre (sin extensión), precalculadas para la búsqueda. */
  words: string[];
  pathNorm: string;
  depth: number;
  /** Acceso de nivel 0 (link de la entrega) del que cuelga. */
  rootRefId: string;
  rootLabel: string;
}

export type DriveIndexStatus = "RUNNING" | "OK" | "PARTIAL" | "ERROR";

export interface ProductDriveIndex {
  productId: string;
  companyId: string;
  status: DriveIndexStatus;
  startedAt: Date;
  finishedAt: Date | null;
  nextSyncAt: Date;
  entries: IndexEntry[];
  byId: Map<string, IndexEntry>;
  children: Map<string, IndexEntry[]>;
  /** Accesos de nivel 0 ya con los docs expandidos. */
  rootRefs: DriveRef[];
  files: number;
  folders: number;
  /** true = se alcanzó el tope de entradas o profundidad: hay carpetas sin indexar. */
  truncated: boolean;
  unindexedFolderIds: string[];
  inaccessible: string[];
  refsHash: string;
  error: string | null;
  /** Milisegundos que tardó la construcción. */
  buildMs: number;
}

export interface DriveProductLike {
  id: string;
  companyId: string;
  digitalDelivery?: { instructions?: string | null; followupMessages?: Array<{ message?: string | null }> | null } | null;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_DEPTH = 6;
const FOLDER_CONCURRENCY = 4;
/** Productos construyéndose a la vez (no saturar la API de Drive). */
const GLOBAL_BUILD_CONCURRENCY = 2;

const indexes = new Map<string, ProductDriveIndex>();
const building = new Map<string, Promise<void>>();
let activeBuilds = 0;
const waiting: Array<() => void> = [];

function maxFiles(): number {
  return Math.max(1000, Number(env.DRIVE_INDEX_MAX_FILES) || 30_000);
}

export function refreshMs(): number {
  return Math.max(1, Number(env.DRIVE_INDEX_REFRESH_HOURS) || 12) * 3_600_000;
}

/** Hash estable de los links de la entrega: si cambia, el índice se rehace. */
export function refsHashFor(refs: DriveRef[]): string {
  const ids = refs
    .map((r) => `${r.kind}:${r.id}`)
    .sort()
    .join("|");
  let h = 5381;
  for (let i = 0; i < ids.length; i++) h = ((h << 5) + h + ids.charCodeAt(i)) | 0;
  return `${refs.length}-${(h >>> 0).toString(36)}`;
}

export function getIndex(productId: string): ProductDriveIndex | undefined {
  return indexes.get(productId);
}

export function isBuilding(productId: string): boolean {
  return building.has(productId);
}

export function allIndexes(): ProductDriveIndex[] {
  return Array.from(indexes.values());
}

/** Solo para tests. */
export function _resetDriveIndexes(): void {
  indexes.clear();
  building.clear();
}

async function acquireBuildSlot(): Promise<void> {
  if (activeBuilds < GLOBAL_BUILD_CONCURRENCY) {
    activeBuilds++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  activeBuilds++;
}

function releaseBuildSlot(): void {
  activeBuilds--;
  const next = waiting.shift();
  if (next) next();
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function makeEntry(
  raw: { id: string; name: string; mimeType: string; size?: string | null },
  parent: { id: string | null; path: string; depth: number; rootRefId: string; rootLabel: string },
): IndexEntry {
  const isFolder = raw.mimeType === FOLDER_MIME;
  const path = parent.path ? `${parent.path} / ${raw.name}` : raw.name;
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    size: raw.size != null && raw.size !== "" ? Number(raw.size) : null,
    isFolder,
    parentId: parent.id,
    path,
    words: nameWords(raw.name),
    // La etiqueta del acceso (sección · viñeta del mensaje de entrega) también cuenta para buscar.
    pathNorm: normalizeText(`${parent.rootLabel} ${path}`),
    depth: parent.depth,
    rootRefId: parent.rootRefId,
    rootLabel: parent.rootLabel,
  };
}

/**
 * Garantiza que el índice del producto exista y esté al día. No espera la
 * construcción (fire-and-forget) salvo que se pida `await`. Devuelve el índice
 * listo si lo hay (puede ser el anterior mientras se rehace).
 */
export function ensureIndex(product: DriveProductLike, opts: { force?: boolean } = {}): ProductDriveIndex | undefined {
  if (!driveSearchEnabled()) return undefined;
  const refs = deliveryDriveRefs(product.digitalDelivery);
  const current = indexes.get(product.id);
  if (!refs.length) {
    if (current) indexes.delete(product.id);
    return undefined;
  }
  const hash = refsHashFor(refs);
  const stale = !current || current.refsHash !== hash || current.nextSyncAt.getTime() <= Date.now() || (current.status === "ERROR" && !current.entries.length);
  if ((opts.force || stale) && !building.has(product.id)) {
    const task = buildIndex(product, refs, hash)
      .catch((err) => console.error(`[drive-index] build falló (product=${product.id}): ${err instanceof Error ? err.message : err}`))
      .finally(() => building.delete(product.id));
    building.set(product.id, task);
  }
  return current;
}

/** Igual que ensureIndex pero espera a que termine la construcción en curso (tests / copiloto reindexar). */
export async function ensureIndexNow(product: DriveProductLike, opts: { force?: boolean } = {}): Promise<ProductDriveIndex | undefined> {
  ensureIndex(product, opts);
  const task = building.get(product.id);
  if (task) await task;
  return indexes.get(product.id);
}

async function buildIndex(product: DriveProductLike, refs: DriveRef[], hash: string): Promise<void> {
  await acquireBuildSlot();
  const startedAt = new Date();
  const t0 = Date.now();
  const limit = maxFiles();
  const previous = indexes.get(product.id);
  try {
    const rootRefs = await expandDocRefs(refs);
    const entries: IndexEntry[] = [];
    const byId = new Map<string, IndexEntry>();
    const children = new Map<string, IndexEntry[]>();
    const inaccessible: string[] = [];
    const push = (e: IndexEntry) => {
      if (byId.has(e.id)) return false;
      byId.set(e.id, e);
      entries.push(e);
      if (e.parentId) {
        const list = children.get(e.parentId) ?? [];
        list.push(e);
        children.set(e.parentId, list);
      }
      return true;
    };

    // Nivel 0: carpetas de la entrega (nombre real vía getFile cuando se pueda) y archivos sueltos.
    let queue: IndexEntry[] = [];
    const roots = await mapLimit(rootRefs, FOLDER_CONCURRENCY, async (ref) => {
      try {
        const meta = await getFile(ref.id);
        if (!meta) {
          inaccessible.push(ref.label || ref.id);
          return null;
        }
        return makeEntry(meta, { id: null, path: "", depth: 0, rootRefId: ref.id, rootLabel: ref.label });
      } catch (error) {
        if (error instanceof DriveAccessError) {
          inaccessible.push(ref.label || ref.id);
          return null;
        }
        throw error;
      }
    });
    for (const e of roots) {
      if (!e) continue;
      push(e);
      if (e.isFolder) queue.push(e);
    }

    let truncated = false;
    const unindexed: string[] = [];
    for (let depth = 1; depth <= MAX_DEPTH && queue.length; depth++) {
      if (entries.length >= limit) {
        truncated = true;
        unindexed.push(...queue.map((q) => q.id));
        break;
      }
      const nextQueue: IndexEntry[] = [];
      let stop = false;
      // Por lotes para poder cortar en el tope sin listar de más.
      for (let i = 0; i < queue.length && !stop; i += FOLDER_CONCURRENCY) {
        const batch = queue.slice(i, i + FOLDER_CONCURRENCY);
        const lists = await mapLimit(batch, FOLDER_CONCURRENCY, async (folder) => {
          try {
            return await listFolder(folder.id);
          } catch (error) {
            if (error instanceof DriveAccessError) {
              inaccessible.push(folder.path);
              return null;
            }
            throw error;
          }
        });
        batch.forEach((folder, j) => {
          const list = lists[j];
          if (!list) return;
          if (list.truncated) truncated = true;
          for (const raw of list.entries) {
            const e = makeEntry(raw, { id: folder.id, path: folder.path, depth, rootRefId: folder.rootRefId, rootLabel: folder.rootLabel });
            if (push(e) && e.isFolder) nextQueue.push(e);
          }
        });
        if (entries.length >= limit) {
          stop = true;
          truncated = true;
          unindexed.push(...queue.slice(i + FOLDER_CONCURRENCY).map((q) => q.id), ...nextQueue.map((q) => q.id));
        }
      }
      queue = stop ? [] : nextQueue;
      if (!stop && depth === MAX_DEPTH && nextQueue.length) {
        truncated = true;
        unindexed.push(...nextQueue.map((q) => q.id));
      }
    }

    let files = 0;
    let folders = 0;
    for (const e of entries) {
      if (e.isFolder) folders++;
      else files++;
    }
    const built: ProductDriveIndex = {
      productId: product.id,
      companyId: product.companyId,
      status: truncated ? "PARTIAL" : "OK",
      startedAt,
      finishedAt: new Date(),
      nextSyncAt: new Date(Date.now() + refreshMs()),
      entries,
      byId,
      children,
      rootRefs,
      files,
      folders,
      truncated,
      unindexedFolderIds: unindexed,
      inaccessible,
      refsHash: hash,
      error: null,
      buildMs: Date.now() - t0,
    };
    indexes.set(product.id, built);
    console.log(
      `[drive-index] product=${product.id} ${built.status}: ${files} archivos, ${folders} carpetas en ${Math.round(built.buildMs / 1000)}s${truncated ? ` (tope ${limit}, ${unindexed.length} carpetas sin indexar)` : ""}${inaccessible.length ? `, ${inaccessible.length} sin acceso` : ""}`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Error de red/cuota: conservar el índice anterior (si lo había) y reintentar en 30 min.
    const fallback: ProductDriveIndex = previous
      ? { ...previous, status: previous.entries.length ? previous.status : "ERROR", error: msg, nextSyncAt: new Date(Date.now() + 30 * 60_000) }
      : {
          productId: product.id,
          companyId: product.companyId,
          status: "ERROR",
          startedAt,
          finishedAt: new Date(),
          nextSyncAt: new Date(Date.now() + 30 * 60_000),
          entries: [],
          byId: new Map(),
          children: new Map(),
          rootRefs: refs,
          files: 0,
          folders: 0,
          truncated: false,
          unindexedFolderIds: [],
          inaccessible: [],
          refsHash: hash,
          error: msg,
          buildMs: Date.now() - t0,
        };
    indexes.set(product.id, fallback);
    console.warn(`[drive-index] product=${product.id} ERROR: ${msg}`);
  } finally {
    releaseBuildSlot();
  }
}

/** Resumen legible del estado del índice (copiloto / ver_configuracion / resultados de tools). */
export function indexSummary(productId: string): {
  estado: "construyendo" | "listo" | "parcial" | "error" | "sin indice";
  archivos: number;
  carpetas: number;
  parcial: boolean;
  ultimaConstruccion: string | null;
  proximaActualizacion: string | null;
  carpetasSinIndexar?: number;
  sinAcceso?: number;
  error?: string;
} {
  const idx = indexes.get(productId);
  const buildingNow = building.has(productId);
  if (!idx) {
    return { estado: buildingNow ? "construyendo" : "sin indice", archivos: 0, carpetas: 0, parcial: false, ultimaConstruccion: null, proximaActualizacion: null };
  }
  return {
    estado: buildingNow && !idx.entries.length ? "construyendo" : idx.status === "ERROR" ? "error" : idx.status === "PARTIAL" ? "parcial" : "listo",
    archivos: idx.files,
    carpetas: idx.folders,
    parcial: idx.truncated,
    ultimaConstruccion: idx.finishedAt?.toISOString() ?? null,
    proximaActualizacion: idx.nextSyncAt.toISOString(),
    ...(idx.unindexedFolderIds.length ? { carpetasSinIndexar: idx.unindexedFolderIds.length } : {}),
    ...(idx.inaccessible.length ? { sinAcceso: idx.inaccessible.length } : {}),
    ...(idx.error ? { error: idx.error.slice(0, 160) } : {}),
  };
}
