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
  tokensOf,
  nameWords,
  normalizeText,
  levenshtein,
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

// ---------------------------------------------------------------------------
// Nivel de coincidencia (para obtener_muestra): la búsqueda aproximada sigue
// igual en buscar_en_drive; aquí solo se CLASIFICA cuán buena es la coincidencia
// para no dar por "encontrado" algo que solo se parece en las letras
// ("metallica" ≈ "medallita").
// ---------------------------------------------------------------------------

export type MatchLevel = "exacta" | "parcial" | "debil";
export const MATCH_RANK: Record<MatchLevel, number> = { exacta: 3, parcial: 2, debil: 1 };
export const MATCH_LEVELS: MatchLevel[] = ["exacta", "parcial", "debil"];

export interface MatchInfo {
  /** null = sin coincidencia. */
  nivel: MatchLevel | null;
  /** 0-1: promedio por palabra del tema (1 exacta, 0.5 aproximada, 0 nada). */
  puntaje: number;
}

/**
 * exacta = todas las palabras del tema aparecen completas en el nombre o la ruta;
 * parcial = al menos una palabra completa de 4+ letras; debil = solo parecido
 * (prefijo, error de tipeo o substring); null = nada.
 */
export function classifyMatch(tema: string, entry: Pick<DriveEntry, "name" | "path">): MatchInfo {
  const tokens = tokensOf(tema);
  if (!tokens.length) return { nivel: null, puntaje: 0 };
  const nameWs = nameWords(entry.name);
  const pathWs = normalizeText(entry.path ?? "").split(" ").filter(Boolean);
  const words = new Set([...nameWs, ...pathWs]);
  const n = nameWs.join(" ");
  const p = pathWs.join(" ");
  let exact = 0;
  let exactSignificant = false;
  let approx = 0;
  for (const t of tokens) {
    if (words.has(t)) {
      exact++;
      if (t.length >= 4) exactSignificant = true;
      continue;
    }
    const wsArr = [...words];
    const near =
      wsArr.some((w) => w.startsWith(t) || (t.length >= 4 && t.startsWith(w) && w.length >= 3)) ||
      (t.length >= 4 && wsArr.some((w) => Math.abs(w.length - t.length) <= 2 && levenshtein(w, t, t.length >= 6 ? 2 : 1) <= (t.length >= 6 ? 2 : 1))) ||
      n.includes(t) ||
      p.includes(t);
    if (near) approx++;
  }
  const puntaje = Math.round(((exact + approx * 0.5) / tokens.length) * 100) / 100;
  if (exact === tokens.length) return { nivel: "exacta", puntaje };
  if (exactSignificant) return { nivel: "parcial", puntaje };
  if (exact + approx > 0) return { nivel: "debil", puntaje };
  return { nivel: null, puntaje: 0 };
}

function meets(level: MatchLevel | null, min: MatchLevel): boolean {
  return level != null && MATCH_RANK[level] >= MATCH_RANK[min];
}

function better(a: MatchLevel | null, b: MatchLevel | null): MatchLevel | null {
  if (!a) return b;
  if (!b) return a;
  return MATCH_RANK[a] >= MATCH_RANK[b] ? a : b;
}

/**
 * 3-5 nombres de carpetas/categorías del producto para ofrecer "lo más parecido":
 * primero carpetas con parecido de letras al tema, luego las categorías principales
 * del pack (carpetas menos profundas con más contenido). Sin semántica.
 */
export async function suggestCategories(product: DriveProductLike, tema: string, max = 5): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const k = normalizeText(name);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(name);
  };
  const idx = ensureIndex(product);
  if (idx && idx.entries.length) {
    const folders = idx.entries.filter((e) => e.isFolder);
    const similar = folders
      .map((e) => ({ e, s: fuzzyScore(tema, e.name, e.name, e.words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.e.depth - b.e.depth);
    for (const x of similar) {
      if (out.length >= max) break;
      push(x.e.name);
    }
    if (out.length < max) {
      const minDepth = folders.length ? Math.min(...folders.map((f) => f.depth)) : 0;
      const main = folders
        .filter((f) => f.depth <= minDepth + 1)
        .map((f) => ({ f, n: idx.children.get(f.id)?.length ?? 0 }))
        .sort((a, b) => a.f.depth - b.f.depth || b.n - a.n || a.f.name.localeCompare(b.f.name));
      for (const x of main) {
        if (out.length >= max) break;
        push(x.f.name);
      }
    }
    return out;
  }
  // Sin índice (construyéndose): etiquetas de los accesos + subcarpetas del primero.
  const refs = deliveryDriveRefs(product.digitalDelivery);
  for (const r of refs) if (r.label) push(r.label);
  const firstFolder = refs.find((r) => r.kind === "folder");
  if (firstFolder && out.length < max) {
    try {
      const r = await browseProductFolder(product, firstFolder.id, { limit: 20 });
      for (const e of r.entries) {
        if (out.length >= max) break;
        if (e.isFolder) push(e.name);
      }
    } catch {
      /* best-effort */
    }
  }
  return out.slice(0, max);
}

export type SamplePick =
  | { file: DriveEntry; via: "archivo" | "carpeta"; folder?: DriveEntry; coincidencia: MatchLevel; puntaje: number }
  | { file: null; coincidencia: MatchLevel | null; puntaje: number; sugerencias: string[] };

function smallestAttachable(candidates: DriveEntry[]): DriveEntry {
  const attachable = candidates
    .filter((e) => {
      const kind = driveFileKind(e);
      const max = DRIVE_ATTACH_MAX_BYTES[kind];
      return max && e.size != null && e.size <= max;
    })
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  return attachable[0] ?? candidates[0];
}

/**
 * UNA muestra (archivo suelto, nunca carpeta) del tema pedido con coincidencia
 * de al menos `minCoincidencia` (default "parcial"): el mejor archivo que
 * coincide; si lo que coincide es una carpeta, un archivo de dentro (el más
 * pequeño que se pueda adjuntar, si no el primero). Si solo hay parecido débil
 * (o nada), devuelve file:null con sugerencias de carpetas/categorías.
 */
export async function pickSample(product: DriveProductLike, tema: string, opts: { minCoincidencia?: MatchLevel } = {}): Promise<SamplePick> {
  const min: MatchLevel = opts.minCoincidencia ?? "parcial";
  let bestSeen: MatchLevel | null = null;
  let bestPuntaje = 0;
  const note = (m: MatchInfo) => {
    bestSeen = better(bestSeen, m.nivel);
    if (m.puntaje > bestPuntaje) bestPuntaje = m.puntaje;
  };

  // 1) Archivos sueltos: el de mejor nivel que cumpla el umbral (desempate: orden del índice).
  const files = await searchProductDrive(product, tema, { filesOnly: true, limit: 10 });
  let bestFile: { file: DriveEntry; m: MatchInfo } | null = null;
  for (const f of files.entries) {
    const m = classifyMatch(tema, f);
    note(m);
    if (!meets(m.nivel, min)) continue;
    if (!bestFile || MATCH_RANK[m.nivel as MatchLevel] > MATCH_RANK[bestFile.m.nivel as MatchLevel]) bestFile = { file: f, m };
  }
  if (bestFile) return { file: bestFile.file, via: "archivo", coincidencia: bestFile.m.nivel as MatchLevel, puntaje: bestFile.m.puntaje };

  // 2) Carpeta que coincide → un archivo de dentro.
  const any = await searchProductDrive(product, tema, { limit: 10 });
  for (const folder of any.entries.filter((e) => e.isFolder)) {
    const fm = classifyMatch(tema, folder);
    note(fm);
    if (!meets(fm.nivel, min)) continue;
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
    if (!candidates.length) continue;
    const file = smallestAttachable(candidates);
    // Vía carpeta: "parcial" salvo que el archivo clasifique exacta por sí mismo.
    const own = classifyMatch(tema, file);
    const coincidencia: MatchLevel = own.nivel === "exacta" ? "exacta" : "parcial";
    return { file, via: "carpeta", folder, coincidencia, puntaje: Math.max(own.puntaje, fm.puntaje) };
  }

  return { file: null, coincidencia: bestSeen, puntaje: bestPuntaje, sugerencias: await suggestCategories(product, tema) };
}

export { driveViewLink, listFolder, isBuilding, getIndex };
export type { DriveRef };
