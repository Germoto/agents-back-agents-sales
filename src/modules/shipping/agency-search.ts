/**
 * Búsqueda aproximada sobre el catálogo de agencias de courier (CourierAgency).
 *
 * El catálogo es común a toda la plataforma (sin companyId) y se copia a nuestra BD con
 * courier-sync.worker: aquí NUNCA se consulta a la courier en vivo. Se busca en memoria
 * (unas 600 filas), sin importar tildes, mayúsculas ni orden, y corrigiendo errores de
 * tipeo contra los nombres del propio catálogo («chiclallo» → Chiclayo). Pesa más lo que
 * coincide con el distrito, luego provincia, departamento, nombre del local y dirección.
 * Solo agencias activas que reciben envíos.
 */

import { prisma } from "../../lib/prisma";
import { levenshtein, normalizeText, tokensOf } from "../../lib/google-drive";
import { MATCH_RANK, type MatchLevel } from "../drive/drive-search";

export interface AgencyRow {
  id: string;
  courier: string;
  externalId: string;
  name: string;
  department: string | null;
  province: string | null;
  district: string | null;
  place: string | null;
  address: string | null;
  schedule: string | null;
  phone: string | null;
  acceptsDestination: boolean;
}

export interface AgencyHit {
  id: string;
  courier: string;
  /** Nombre listo para mostrar: «Shalom Calle Berlin (Miraflores, Lima)». */
  nombre: string;
  departamento: string | null;
  provincia: string | null;
  distrito: string | null;
  direccion: string | null;
  horario: string | null;
  telefono: string | null;
  /** exacta | parcial | debil: qué tan bien coincide con lo buscado. */
  coincidencia: MatchLevel;
}

export interface AgencySearchResult {
  total: number;
  results: AgencyHit[];
  hayMas: boolean;
  /** Siguiente offset si hayMas. */
  siguienteOffset: number | null;
}

interface Indexed {
  row: AgencyRow;
  district: string[];
  province: string[];
  department: string[];
  place: string[];
  address: string[];
  districtText: string;
}

const CACHE_TTL_MS = 10 * 60_000;
let cache: { at: number; items: Indexed[] } | null = null;
let loading: Promise<Indexed[]> | null = null;

/** Palabras que no ayudan a ubicar una agencia. */
const STOPWORDS = new Set([
  "agencia", "agencias", "shalom", "courier", "de", "del", "la", "las", "el", "los", "en", "por", "para", "cerca", "que", "hay", "una", "un", "mi", "al", "sede", "sedes", "oficina", "oficinas", "envio", "envios",
]);

const title = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/(^|[\s(\/.-])([a-záéíóúñ])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .trim();

const COURIER_LABELS: Record<string, string> = { SHALOM: "Shalom" };
export const courierLabel = (c: string | null | undefined) => (c ? COURIER_LABELS[c.toUpperCase()] ?? title(c) : "");

/** Nombre corto para mostrar y para guardar en el pedido. */
export function agencyDisplayName(a: Pick<AgencyRow, "courier" | "place" | "district" | "province" | "department" | "name">): string {
  const place = title(a.place || a.district || a.name);
  const zone = [a.district, a.province, a.department]
    .map((x) => title(x))
    .filter((x, i, arr) => x && x.toLowerCase() !== place.toLowerCase() && arr.indexOf(x) === i)
    .slice(0, 2);
  return `${courierLabel(a.courier)} ${place}${zone.length ? ` (${zone.join(", ")})` : ""}`.trim();
}

const wordsOf = (v: string | null | undefined) => normalizeText(v ?? "").split(" ").filter(Boolean);

function index(row: AgencyRow): Indexed {
  const district = wordsOf(row.district);
  return {
    row,
    district,
    province: wordsOf(row.province),
    department: wordsOf(row.department),
    place: wordsOf(row.place),
    address: wordsOf(row.address),
    districtText: district.join(" "),
  };
}

async function loadAll(): Promise<Indexed[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.items;
  if (loading) return loading;
  loading = prisma.courierAgency
    .findMany({
      where: { isActive: true, acceptsDestination: true },
      select: {
        id: true, courier: true, externalId: true, name: true, department: true, province: true, district: true,
        place: true, address: true, schedule: true, phone: true, acceptsDestination: true,
      },
      orderBy: [{ department: "asc" }, { province: "asc" }, { district: "asc" }, { place: "asc" }],
    })
    .then((rows) => {
      const items = rows.map(index);
      cache = { at: Date.now(), items };
      return items;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Tras una sincronización: que la próxima búsqueda relea la BD. */
export function invalidateAgencyCache(): void {
  cache = null;
}

function toHit(it: Indexed, nivel: MatchLevel): AgencyHit {
  const a = it.row;
  return {
    id: a.id,
    courier: a.courier,
    nombre: agencyDisplayName(a),
    departamento: title(a.department) || null,
    provincia: title(a.province) || null,
    distrito: title(a.district) || null,
    direccion: a.address?.trim() || null,
    horario: a.schedule?.trim() || null,
    telefono: a.phone?.trim() || null,
    coincidencia: nivel,
  };
}

/** Peso de cada campo: lo que el cliente nombra casi siempre es la ciudad o el distrito. */
const FIELDS: Array<{ key: "district" | "province" | "department" | "place" | "address"; weight: number }> = [
  { key: "district", weight: 5 },
  { key: "province", weight: 4 },
  { key: "department", weight: 3 },
  { key: "place", weight: 3 },
  { key: "address", weight: 1 },
];

/**
 * Corrige errores de tipeo de la consulta contra las palabras del catálogo (distrito,
 * provincia, departamento y nombre del local). Devuelve el término y si fue corregido.
 */
function correctTerms(terms: string[], items: Indexed[]): Array<{ term: string; fixed: boolean }> {
  const freq = new Map<string, number>();
  for (const it of items) for (const w of [...it.district, ...it.province, ...it.department, ...it.place]) freq.set(w, (freq.get(w) ?? 0) + 1);
  return terms.map((t) => {
    if (t.length < 4 || freq.has(t)) return { term: t, fixed: false };
    for (const w of freq.keys()) if (w.startsWith(t)) return { term: t, fixed: false };
    const max = t.length >= 6 ? 2 : 1;
    let best: { w: string; d: number; n: number } | null = null;
    for (const [w, n] of freq) {
      if (w.length < 4 || Math.abs(w.length - t.length) > max) continue;
      const d = levenshtein(w, t, max);
      if (d > max) continue;
      if (!best || d < best.d || (d === best.d && n > best.n)) best = { w, d, n };
    }
    return best ? { term: best.w, fixed: true } : { term: t, fixed: false };
  });
}

/** Puro (sin BD): ordena y pagina. Se exporta para probarlo contra la lista real. */
export function rankAgencies(
  items: Indexed[],
  opts: { query: string; couriers?: string[]; offset?: number; limit?: number },
): AgencySearchResult {
  const limit = Math.min(20, Math.max(1, opts.limit ?? 5));
  const offset = Math.max(0, opts.offset ?? 0);
  const couriers = opts.couriers?.length ? new Set(opts.couriers.map((c) => c.toUpperCase())) : null;
  const pool = couriers ? items.filter((it) => couriers.has(it.row.courier.toUpperCase())) : items;
  const raw = tokensOf(opts.query).filter((t) => !STOPWORDS.has(t));
  if (!raw.length) return { total: 0, results: [], hayMas: false, siguienteOffset: null };
  const terms = correctTerms(raw, pool);
  const fullQuery = terms.map((t) => t.term).join(" ");

  // Con una palabra «de peso» en la consulta (4+ letras), coincidir solo en las cortas
  // («san», «la») no cuenta: «san isidro» sin agencias no debe listar todos los «San …».
  const needSignificant = terms.some((t) => t.term.length >= 4);

  const scored: Array<{ it: Indexed; nivel: MatchLevel; score: number; hits: number }> = [];
  for (const it of pool) {
    let score = 0;
    let hits = 0;
    let significantHits = 0;
    let exact = 0;
    let exactSignificant = false;
    for (const { term, fixed } of terms) {
      let best = 0;
      let isExact = false;
      for (const f of FIELDS) {
        const ws = it[f.key];
        if (ws.includes(term)) {
          if (f.weight > best) best = f.weight;
          isExact = true;
        } else if (term.length >= 3 && ws.some((w) => w.startsWith(term))) {
          if (f.weight * 0.6 > best) best = f.weight * 0.6;
        }
      }
      if (!best) continue;
      score += best;
      hits++;
      if (term.length >= 4) significantHits++;
      // Un término corregido cuenta como aproximado: el agente debe confirmar la zona.
      if (isExact && !fixed) {
        exact++;
        if (term.length >= 4) exactSignificant = true;
      }
    }
    if (!hits || (needSignificant && !significantHits)) continue;
    // El distrito nombrado completo («miraflores» ≠ «san juan de miraflores»).
    if (it.districtText && (it.districtText === fullQuery || ` ${fullQuery} `.includes(` ${it.districtText} `))) score += 3;
    const nivel: MatchLevel = exact === terms.length ? "exacta" : exactSignificant ? "parcial" : "debil";
    scored.push({ it, nivel, score, hits });
  }
  // Primero las que cubren más términos de la consulta; luego por peso.
  scored.sort((a, b) => b.hits - a.hits || b.score - a.score || MATCH_RANK[b.nivel] - MATCH_RANK[a.nivel]);
  const page = scored.slice(offset, offset + limit);
  const hayMas = offset + limit < scored.length;
  return { total: scored.length, results: page.map((s) => toHit(s.it, s.nivel)), hayMas, siguienteOffset: hayMas ? offset + limit : null };
}

/** Para pruebas: arma el índice desde filas sueltas. */
export function indexAgencies(rows: AgencyRow[]): Indexed[] {
  return rows.map(index);
}

export async function searchAgencies(opts: { query: string; couriers?: string[]; offset?: number; limit?: number }): Promise<AgencySearchResult> {
  return rankAgencies(await loadAll(), opts);
}

/** Agencia por id (para guardar su foto en el pedido). null si no existe o está inactiva. */
export async function findAgencyById(id: string): Promise<(AgencyRow & { displayName: string }) | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? "")) return null;
  const all = await loadAll();
  const hit = all.find((x) => x.row.id === id);
  if (hit) return { ...hit.row, displayName: agencyDisplayName(hit.row) };
  return null;
}
