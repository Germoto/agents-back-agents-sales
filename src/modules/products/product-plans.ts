/**
 * Planes con precio de un producto (Mensual, 3 meses, 1 año…). Se guardan como el
 * grupo de modificadores "Plan" en verticalData.modifierGroups (mismo motor que los
 * planes de Streaming): price = precio del plan más barato y cada opción guarda su
 * diferencia (priceDelta). El carrito recalcula base + delta, así el mensaje de cobro
 * y la validación usan el precio del plan elegido.
 */

export type PlanOption = { label: string; price: number };

const PLAN_GROUP_RE = /^plan(es)?$/i;

type Group = { name?: string; required?: boolean; options?: Array<{ label?: string; priceDelta?: number }> };

/** Grupo "Plan" del producto, o null. */
export function planGroupOf(verticalData: unknown): Group | null {
  const groups = (verticalData as { modifierGroups?: unknown } | null)?.modifierGroups;
  if (!Array.isArray(groups)) return null;
  const g = (groups as Group[]).find((x) => x?.name && PLAN_GROUP_RE.test(x.name.trim()));
  return g && Array.isArray(g.options) && g.options.some((o) => o?.label) ? g : null;
}

export function parseAmount(text: unknown): number {
  let s = String(text ?? "");
  // "1,200.50" → miles con coma; "19,99" → decimal con coma.
  s = /\d,\d{3}(\D|$)/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Planes con precio ABSOLUTO (base + delta). */
export function planOptions(verticalData: unknown, basePrice: unknown): PlanOption[] {
  const g = planGroupOf(verticalData);
  if (!g) return [];
  const base = parseAmount(basePrice);
  return (g.options ?? [])
    .filter((o) => o?.label)
    .map((o) => ({ label: String(o.label), price: Math.round((base + (Number(o.priceDelta) || 0)) * 100) / 100 }));
}

/** true si el texto es SOLO un monto ("19.99", "S/ 19.99", "$ 20"), sin palabras ("Desde…", "al mes"). */
export function isPlainAmount(text: unknown): boolean {
  const s = String(text ?? "").trim();
  if (!s) return false;
  return /^(s\/|us\$|\$|€|pen|usd)?\s*\d{1,3}([.,\s]?\d{3})*([.,]\d{1,2})?$/i.test(s) || /^(s\/|us\$|\$|€|pen|usd)?\s*\d+([.,]\d{1,2})?$/i.test(s);
}

/**
 * Planes [{label, price}] → { price: el del más barato, group: "Plan" con deltas }.
 * Lanza Error con un mensaje claro si algún plan no tiene nombre o precio.
 */
export function buildPlanGroup(plans: PlanOption[]): { price: string; group: Required<Group> } {
  if (!plans.length) throw new Error("planes vacío");
  for (const p of plans) {
    if (!p.label.trim()) throw new Error("Cada plan necesita un nombre");
    if (!(p.price > 0)) throw new Error(`El plan «${p.label}» necesita un precio mayor a 0`);
  }
  const base = Math.min(...plans.map((p) => p.price));
  return {
    price: String(base),
    group: {
      name: "Plan",
      required: true,
      options: plans.map((p) => ({ label: p.label.trim(), priceDelta: Math.round((p.price - base) * 100) / 100 })),
    },
  };
}

/** Normaliza lo que manda el Copiloto: [{nombre|label|name, precio|price}]. */
export function parsePlanInput(raw: unknown): PlanOption[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const label = String(o.nombre ?? o.label ?? o.name ?? o.plan ?? "").trim();
    return { label, price: parseAmount(o.precio ?? o.price ?? o.monto) };
  });
}
