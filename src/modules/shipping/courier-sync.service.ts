/**
 * Copia del catálogo de agencias de Shalom a nuestra BD.
 *
 * La lista sale del mismo endpoint público que usa la web de Shalom (no es un servicio
 * oficial ni garantizado): se descarga con tope de tiempo, se valida que venga completa y
 * recién entonces se guarda. Si algo falla, queda la copia anterior. Nunca se borra: las
 * agencias que dejan de venir se marcan inactivas (los pedidos guardan su propia foto).
 */

import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { normalizeText } from "../../lib/google-drive";
import { invalidateAgencyCache } from "./agency-search";

const COURIER = "SHALOM";
const FETCH_TIMEOUT_MS = 60_000;
/** Menos que esto = respuesta rota o parcial: no se toca la copia. */
const MIN_AGENCIES = 300;

export interface ParsedAgency {
  externalId: string;
  name: string;
  department: string | null;
  province: string | null;
  district: string | null;
  place: string | null;
  address: string | null;
  schedule: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  ubigeo: string | null;
  acceptsDestination: boolean;
  searchText: string;
}

const str = (v: unknown, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/** Respuesta cruda de Shalom → filas limpias. Lanza si no tiene la forma esperada. Puro. */
export function parseShalomAgencies(payload: unknown): ParsedAgency[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("respuesta sin lista de agencias");
  const out: ParsedAgency[] = [];
  const seen = new Set<string>();
  for (const raw of data as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    const externalId = str(raw.ter_id, 40);
    const name = str(raw.nombre) ?? str(raw.lugar_over) ?? str(raw.zona);
    if (!externalId || !name || seen.has(externalId)) continue;
    seen.add(externalId);
    const department = str(raw.departamento, 80);
    const province = str(raw.provincia, 80);
    const district = str(raw.zona, 80);
    const place = str(raw.lugar_over, 120) ?? str(raw.lugar, 120);
    const address = str(raw.direccion, 400);
    out.push({
      externalId,
      name,
      department,
      province,
      district,
      place,
      address,
      schedule: str(raw.hora_atencion, 200),
      phone: str(raw.telefono, 60),
      latitude: num(raw.latitud),
      longitude: num(raw.longitud),
      ubigeo: str(raw.ubi_id, 12),
      acceptsDestination: String(raw.destino ?? "1") !== "0",
      searchText: normalizeText([department, province, district, place, address].filter(Boolean).join(" ")),
    });
  }
  if (out.length < MIN_AGENCIES) throw new Error(`solo ${out.length} agencias válidas (mínimo ${MIN_AGENCIES})`);
  return out;
}

export interface SyncResult {
  ok: boolean;
  total: number;
  deactivated: number;
  error?: string;
}

export async function syncShalomAgencies(): Promise<SyncResult> {
  const url = env.SHALOM_AGENCIES_URL;
  if (!url) return { ok: false, total: 0, deactivated: 0, error: "SHALOM_AGENCIES_URL vacío" };
  let parsed: ParsedAgency[];
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    parsed = parseShalomAgencies(await res.json());
  } catch (err) {
    // Se conserva la copia anterior tal cual.
    return { ok: false, total: 0, deactivated: 0, error: err instanceof Error ? err.message : String(err) };
  }

  const now = new Date();
  for (let i = 0; i < parsed.length; i += 50) {
    await prisma.$transaction(
      parsed.slice(i, i + 50).map((a) => {
        const { externalId, ...fields } = a;
        return prisma.courierAgency.upsert({
          where: { courier_externalId: { courier: COURIER, externalId } },
          create: { courier: COURIER, externalId, ...fields, isActive: true, syncedAt: now },
          update: { ...fields, isActive: true, syncedAt: now },
        });
      }),
    );
  }
  // Las que ya no vienen: inactivas, nunca borradas.
  const gone = await prisma.courierAgency.updateMany({
    where: { courier: COURIER, isActive: true, externalId: { notIn: parsed.map((a) => a.externalId) } },
    data: { isActive: false },
  });
  invalidateAgencyCache();
  return { ok: true, total: parsed.length, deactivated: gone.count };
}

/** Estado del catálogo para el panel y el Copiloto. */
export async function agencyCatalogStatus() {
  const [active, receiving, last] = await Promise.all([
    prisma.courierAgency.count({ where: { courier: COURIER, isActive: true } }),
    prisma.courierAgency.count({ where: { courier: COURIER, isActive: true, acceptsDestination: true } }),
    prisma.courierAgency.aggregate({ where: { courier: COURIER }, _max: { syncedAt: true } }),
  ]);
  return { courier: COURIER, total: active, recibenEnvios: receiving, syncedAt: last._max.syncedAt ?? null };
}
