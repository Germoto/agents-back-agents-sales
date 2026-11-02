/**
 * Búsqueda en vivo sobre las carpetas PÚBLICAS de Google Drive que viven en la
 * entrega de un producto (instructions + followupMessages). No se guarda nada en
 * FlowApp: cada consulta va a la API de Drive (v3) con la API key de la plataforma
 * (GOOGLE_DRIVE_API_KEY) y un caché en memoria de corta vida.
 *
 * Solo funciona con carpetas/archivos compartidos "cualquiera con el enlace"; con
 * una key la API lista y lee esos recursos sin OAuth ni verificación de Google.
 */

import { env } from "../config/env";

export type DriveRefKind = "folder" | "file" | "doc";

export interface DriveRef {
  kind: DriveRefKind;
  id: string;
  /** Texto que acompaña al link en el mensaje (encabezado de sección + viñeta), para buscar por tema. */
  label: string;
}

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  /** bytes; null en carpetas y documentos nativos de Google. */
  size: number | null;
  isFolder: boolean;
  /** Carpeta contenedora conocida (null para accesos de primer nivel). */
  parentId: string | null;
  /** Ruta legible: "GATOS IA · 900 AI Cat Long Reels / video.mp4". */
  path: string;
}

export type DriveFileKind = "carpeta" | "video" | "imagen" | "audio" | "pdf" | "documento" | "otro";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const API = "https://www.googleapis.com/drive/v3";
const PAGE_SIZE = 1000;
/** La API devuelve páginas PARCIALES (menos de pageSize) con nextPageToken: se sigue el token
 *  hasta agotarlo, con tope de seguridad de páginas/entradas por carpeta. */
const MAX_PAGES = 40;
const MAX_ENTRIES_PER_FOLDER = 10_000;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_FOLDERS = 3000;
const LIST_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 12_000;

export function driveSearchEnabled(): boolean {
  return Boolean(env.GOOGLE_DRIVE_API_KEY?.trim());
}

// ---------------------------------------------------------------------------
// Extracción de links de Drive de un texto (mensajes de entrega)
// ---------------------------------------------------------------------------

const DRIVE_URL_RE =
  /https?:\/\/(?:drive|docs)\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|file\/d\/|document\/d\/|open\?id=|uc\?(?:[^\s]*&)?id=)([A-Za-z0-9_-]{10,})[^\s]*/g;

function refKindFor(url: string): DriveRefKind {
  if (/\/folders\//.test(url)) return "folder";
  if (/docs\.google\.com\/document\//.test(url)) return "doc";
  return "file";
}

function cleanLabelLine(line: string): string {
  return line
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[•·▪●►▶👉👇⬇️]/gu, " ")
    .replace(/[\p{Extended_Pictographic}️]/gu, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Devuelve los links de Drive del texto, con una etiqueta tomada de las líneas
 * de texto que preceden al link (hasta dos: encabezado de sección + viñeta).
 * Dedupe por id (gana la primera aparición).
 */
export function extractDriveRefs(text: string): DriveRef[] {
  const out: DriveRef[] = [];
  const seen = new Set<string>();
  const lines = (text ?? "").split(/\r?\n/);
  // Encabezado de sección (línea sin viñeta) y viñeta (línea que empieza con •, -, *, 1.)
  // previas al link; la viñeta se consume con el link, el encabezado dura hasta el siguiente.
  let section = "";
  let bullet = "";
  const isBullet = (line: string) => /^(?:[•·▪●►▶\-*]|\d+[.)])\s*/.test(line);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const matches = Array.from(line.matchAll(DRIVE_URL_RE));
    if (!matches.length) {
      const t = cleanLabelLine(line);
      if (!t) continue;
      if (isBullet(line)) bullet = t;
      else {
        section = t;
        bullet = "";
      }
      continue;
    }
    const inline = cleanLabelLine(line);
    const label = [section, bullet, inline].filter(Boolean).join(" · ").slice(0, 140);
    for (const m of matches) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind: refKindFor(m[0]), id, label });
    }
    bullet = "";
  }
  return out;
}

/** Links de Drive de toda la entrega (instrucciones + mensajes adicionales). */
export function deliveryDriveRefs(dd: { instructions?: string | null; followupMessages?: Array<{ message?: string | null }> | null } | null | undefined): DriveRef[] {
  if (!dd) return [];
  const texts = [dd.instructions ?? "", ...(dd.followupMessages ?? []).map((f) => f?.message ?? "")];
  const out: DriveRef[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    for (const r of extractDriveRefs(t)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Links y tipos
// ---------------------------------------------------------------------------

export function driveViewLink(entry: Pick<DriveEntry, "id" | "isFolder" | "mimeType">): string {
  if (entry.isFolder) return `https://drive.google.com/drive/folders/${entry.id}`;
  if (entry.mimeType === DOC_MIME) return `https://docs.google.com/document/d/${entry.id}/edit`;
  return `https://drive.google.com/file/d/${entry.id}/view`;
}

/** URL de descarga directa (bytes) de un archivo público; sirve para enviarlo como multimedia. */
export function driveDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

export function driveFileKind(entry: Pick<DriveEntry, "isFolder" | "mimeType" | "name">): DriveFileKind {
  if (entry.isFolder) return "carpeta";
  const m = (entry.mimeType ?? "").toLowerCase();
  const ext = (entry.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "").toLowerCase();
  if (m.startsWith("video/") || ["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "video";
  if (m.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "imagen";
  if (m.startsWith("audio/") || ["mp3", "wav", "m4a", "aac", "ogg", "flac", "aif", "aiff"].includes(ext)) return "audio";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m.startsWith("application/vnd.google-apps.") || ["doc", "docx", "txt"].includes(ext)) return "documento";
  return "otro";
}

/** Tope para mandar el archivo como adjunto por WhatsApp (por encima va solo el link). */
export const DRIVE_ATTACH_MAX_BYTES: Record<string, number> = {
  imagen: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Cliente Drive v3 (API key) + caché
// ---------------------------------------------------------------------------

type RawFile = { id: string; name: string; mimeType: string; size?: string };

interface CacheItem<T> {
  at: number;
  value: T;
}

const folderCache = new Map<string, CacheItem<{ entries: RawFile[]; truncated: boolean; deniedStatus?: number }>>();
const fileCache = new Map<string, CacheItem<RawFile | null>>();
const docCache = new Map<string, CacheItem<string>>();

function cacheGet<T>(map: Map<string, CacheItem<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheItem<T>>, key: string, value: T): void {
  if (map.size >= MAX_CACHE_FOLDERS) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, { at: Date.now(), value });
}

/** Solo para tests: limpia el caché. */
export function _resetDriveCache(): void {
  folderCache.clear();
  fileCache.clear();
  docCache.clear();
}

export class DriveAccessError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function driveFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = env.GOOGLE_DRIVE_API_KEY?.trim();
  if (!key) throw new DriveAccessError("GOOGLE_DRIVE_API_KEY no configurada", 0);
  const qs = new URLSearchParams({ ...params, key, supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await driveFetch(`${API}${path}?${qs.toString()}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new DriveAccessError(`Drive ${res.status}: ${detail.slice(0, 200)}`, res.status);
  }
  return (await res.json()) as T;
}

/** Lista una carpeta pública completa (siguiendo nextPageToken; tope de seguridad), con caché. */
export async function listFolder(folderId: string): Promise<{ entries: RawFile[]; truncated: boolean }> {
  const cached = cacheGet(folderCache, folderId);
  if (cached) {
    if (cached.deniedStatus) throw new DriveAccessError(`Drive ${cached.deniedStatus}: sin acceso (caché)`, cached.deniedStatus);
    return cached;
  }
  const entries: RawFile[] = [];
  let pageToken: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    let data: { files?: RawFile[]; nextPageToken?: string };
    try {
      data = await apiJson<{ files?: RawFile[]; nextPageToken?: string }>("/files", {
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,size)",
      pageSize: String(PAGE_SIZE),
      orderBy: "folder,name",
      ...(pageToken ? { pageToken } : {}),
      });
    } catch (error) {
      // Carpeta privada/inexistente: se recuerda durante el TTL para no insistir en cada búsqueda.
      if (error instanceof DriveAccessError && (error.status === 403 || error.status === 404)) {
        cacheSet(folderCache, folderId, { entries: [], truncated: false, deniedStatus: error.status });
      }
      throw error;
    }
    entries.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (page === MAX_PAGES - 1 || entries.length >= MAX_ENTRIES_PER_FOLDER) {
      truncated = true;
      break;
    }
  }
  const value = { entries, truncated };
  cacheSet(folderCache, folderId, value);
  return value;
}

/** Metadatos de un archivo/carpeta público; null si no existe o no es accesible. */
export async function getFile(id: string): Promise<RawFile | null> {
  const cached = cacheGet(fileCache, id);
  if (cached !== undefined) return cached;
  let value: RawFile | null;
  try {
    value = await apiJson<RawFile>(`/files/${encodeURIComponent(id)}`, { fields: "id,name,mimeType,size" });
  } catch (error) {
    if (error instanceof DriveAccessError && (error.status === 403 || error.status === 404)) value = null;
    else throw error;
  }
  cacheSet(fileCache, id, value);
  return value;
}

/** Texto plano de un Google Doc público (export sin key; fallback a la API). */
export async function readDocText(docId: string): Promise<string> {
  const cached = cacheGet(docCache, docId);
  if (cached !== undefined) return cached;
  let text = "";
  try {
    const res = await driveFetch(`https://docs.google.com/document/d/${encodeURIComponent(docId)}/export?format=txt`);
    if (res.ok) text = await res.text();
  } catch {
    text = "";
  }
  if (!text) {
    try {
      const key = env.GOOGLE_DRIVE_API_KEY?.trim() ?? "";
      const res = await driveFetch(`${API}/files/${encodeURIComponent(docId)}/export?mimeType=text/plain&key=${encodeURIComponent(key)}`);
      if (res.ok) text = await res.text();
    } catch {
      text = "";
    }
  }
  cacheSet(docCache, docId, text);
  return text;
}

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------

export function normalizeText(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(q: string): string[] {
  return normalizeText(q)
    .split(" ")
    .filter((t) => t.length >= 2);
}

/** Puntaje de coincidencia de una consulta contra nombre y ruta (0 = no coincide). */
export function scoreEntry(query: string, name: string, path: string): number {
  const tokens = tokensOf(query);
  if (!tokens.length) return 0;
  const n = normalizeText(name);
  const p = normalizeText(path);
  let score = 0;
  let hits = 0;
  for (const t of tokens) {
    const stem = t.length > 4 ? t.slice(0, -1) : t;
    if (n.includes(t)) {
      score += 3;
      hits++;
    } else if (n.includes(stem)) {
      score += 2;
      hits++;
    } else if (p.includes(t)) {
      score += 2;
      hits++;
    } else if (p.includes(stem)) {
      score += 1;
      hits++;
    }
  }
  if (!hits) return 0;
  // Todos los términos presentes => bonus; nombre exacto => más.
  if (hits === tokens.length) score += 2;
  if (n === tokens.join(" ")) score += 3;
  return score;
}

/** Palabras normalizadas de un nombre (sin extensión), para la búsqueda aproximada. */
export function nameWords(name: string): string[] {
  return normalizeText(name.replace(/\.[a-z0-9]{2,5}$/i, ""))
    .split(" ")
    .filter(Boolean);
}

/** Distancia de edición (Levenshtein) con corte temprano en `max`. */
export function levenshtein(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Puntaje aproximado: por cada término de la consulta, palabra exacta (3) > prefijo (2) >
 * error de tipeo ≤ 2 letras (2, solo en términos de 4+ letras) > aparece en la ruta (1).
 * Sin importar mayúsculas, tildes ni orden. Bonus si todos los términos coinciden.
 */
export function fuzzyScore(query: string, name: string, path: string, words?: string[]): number {
  const tokens = tokensOf(query);
  if (!tokens.length) return 0;
  const ws = words ?? nameWords(name);
  const n = ws.join(" ");
  const p = normalizeText(path);
  let score = 0;
  let hits = 0;
  for (const t of tokens) {
    let best = 0;
    if (ws.includes(t)) best = 3;
    else if (ws.some((w) => w.startsWith(t) || (t.length >= 4 && t.startsWith(w) && w.length >= 3))) best = 2;
    else if (t.length >= 4 && ws.some((w) => Math.abs(w.length - t.length) <= 2 && levenshtein(w, t, t.length >= 6 ? 2 : 1) <= (t.length >= 6 ? 2 : 1))) best = 2;
    else if (n.includes(t)) best = 2;
    else if (p.includes(t)) best = 1;
    if (best) {
      score += best;
      hits++;
    }
  }
  if (!hits) return 0;
  if (hits === tokens.length) score += 2;
  if (n === tokens.join(" ")) score += 3;
  return score;
}

function toEntry(raw: RawFile, parentId: string | null, parentPath: string): DriveEntry {
  const isFolder = raw.mimeType === FOLDER_MIME;
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    size: raw.size != null && raw.size !== "" ? Number(raw.size) : null,
    isFolder,
    parentId,
    path: parentPath ? `${parentPath} / ${raw.name}` : raw.name,
  };
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

export interface DriveSearchResult {
  entries: DriveEntry[];
  /** Carpetas de primer nivel (de la entrega) a las que Drive negó el acceso. */
  inaccessible: string[];
  /** Cuántas carpetas se consultaron en Drive para esta búsqueda. */
  foldersScanned: number;
}

/**
 * Expande los docs de Google de la entrega: sus links internos pasan a ser
 * accesos de primer nivel (con la etiqueta del doc).
 */
export async function expandDocRefs(refs: DriveRef[]): Promise<DriveRef[]> {
  const docs = refs.filter((r) => r.kind === "doc");
  if (!docs.length) return refs;
  const out = refs.filter((r) => r.kind !== "doc");
  const seen = new Set(out.map((r) => r.id));
  const texts = await mapLimit(docs, 3, (d) => readDocText(d.id).catch(() => ""));
  docs.forEach((d, i) => {
    for (const r of extractDriveRefs(texts[i] ?? "")) {
      if (r.kind === "doc" || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, label: r.label || d.label });
    }
  });
  return out;
}

/**
 * Busca `query` entre los accesos de la entrega (nivel 0: etiquetas de los links)
 * y dentro de sus carpetas (nivel 1). Si alguna carpeta de nivel 0 coincide por
 * etiqueta, se listan solo esas (hasta 6); si ninguna coincide, se listan todas
 * (en paralelo, con caché) y se busca por nombre de archivo/subcarpeta.
 */
export async function searchDrive(refs: DriveRef[], query: string, opts: { limit?: number } = {}): Promise<DriveSearchResult> {
  const limit = opts.limit ?? 12;
  const expanded = await expandDocRefs(refs);
  const scored: Array<{ entry: DriveEntry; score: number }> = [];
  const inaccessible: string[] = [];

  // Nivel 0: los accesos tal cual, puntuados por su etiqueta (sin llamar a Drive).
  const level0 = expanded.map((r) => ({
    ref: r,
    entry: {
      id: r.id,
      name: r.label || r.id,
      mimeType: r.kind === "folder" ? FOLDER_MIME : "",
      size: null,
      isFolder: r.kind === "folder",
      parentId: null,
      path: r.label || r.id,
    } as DriveEntry,
    score: scoreEntry(query, r.label || "", r.label || ""),
  }));
  for (const l of level0) if (l.score > 0) scored.push({ entry: l.entry, score: l.score + 1 });

  const matchedFolders = level0.filter((l) => l.ref.kind === "folder" && l.score > 0).sort((a, b) => b.score - a.score);
  const toScan = (matchedFolders.length ? matchedFolders.slice(0, 6) : level0.filter((l) => l.ref.kind === "folder")).map((l) => l.ref);

  const lists = await mapLimit(toScan, LIST_CONCURRENCY, async (ref) => {
    try {
      return await listFolder(ref.id);
    } catch (error) {
      if (error instanceof DriveAccessError && (error.status === 403 || error.status === 404)) {
        inaccessible.push(ref.label || ref.id);
        return null;
      }
      throw error;
    }
  });

  toScan.forEach((ref, i) => {
    const list = lists[i];
    if (!list) return;
    for (const raw of list.entries) {
      const entry = toEntry(raw, ref.id, ref.label);
      const s = scoreEntry(query, entry.name, entry.path);
      if (s > 0) scored.push({ entry, score: s });
    }
  });

  scored.sort((a, b) => b.score - a.score || Number(b.entry.isFolder) - Number(a.entry.isFolder) || a.entry.name.localeCompare(b.entry.name));
  const seen = new Set<string>();
  const entries: DriveEntry[] = [];
  for (const s of scored) {
    if (seen.has(s.entry.id)) continue;
    seen.add(s.entry.id);
    entries.push(s.entry);
    if (entries.length >= limit) break;
  }
  return { entries, inaccessible, foldersScanned: toScan.length };
}

/** Lista el contenido de una carpeta (opcionalmente filtrado por `query`), con metadatos de la carpeta. */
export async function browseFolder(
  folderId: string,
  opts: { query?: string; offset?: number; limit?: number; parentPath?: string } = {},
): Promise<{ folder: DriveEntry | null; entries: DriveEntry[]; total: number; truncated: boolean }> {
  const limit = opts.limit ?? 40;
  const offset = opts.offset ?? 0;
  const meta = await getFile(folderId);
  if (!meta) return { folder: null, entries: [], total: 0, truncated: false };
  const folder = toEntry(meta, null, opts.parentPath ?? "");
  if (meta.mimeType !== FOLDER_MIME) {
    return { folder, entries: [folder], total: 1, truncated: false };
  }
  const list = await listFolder(folderId);
  const base = folder?.path ?? opts.parentPath ?? "";
  let entries = list.entries.map((raw) => toEntry(raw, folderId, base));
  if (opts.query?.trim()) {
    entries = entries
      .map((e) => ({ e, s: fuzzyScore(opts.query!, e.name, e.name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.e);
  }
  const total = entries.length;
  return { folder, entries: entries.slice(offset, offset + limit), total, truncated: list.truncated };
}

/** Conteo rápido del contenido de una carpeta: cuántos archivos y subcarpetas. */
export async function folderStats(folderId: string): Promise<{ files: number; folders: number; truncated: boolean }> {
  const list = await listFolder(folderId);
  let files = 0;
  let folders = 0;
  for (const e of list.entries) {
    if (e.mimeType === FOLDER_MIME) folders++;
    else files++;
  }
  return { files, folders, truncated: list.truncated };
}

/** Vista compacta de una entrada para el modelo. */
export function describeEntry(entry: DriveEntry, withLink: boolean) {
  const tipo = driveFileKind(entry);
  return {
    id: entry.id,
    nombre: entry.name,
    tipo,
    ruta: entry.path !== entry.name ? entry.path : undefined,
    tamanoMB: entry.size != null ? Math.round((entry.size / 1024 / 1024) * 10) / 10 : undefined,
    link: withLink ? driveViewLink(entry) : null,
  };
}
