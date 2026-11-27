/**
 * «Por anuncio» del dashboard: cálculo puro (sin base de datos) para poder probarlo.
 *
 * Separa dos preguntas que antes iban mezcladas en la misma fila:
 *  - Los que ESCRIBIERON en el periodo por el anuncio: ¿cuántos ya compraron? (cohorte)
 *  - Lo que se COBRÓ en el periodo por el anuncio: ¿viene de quienes escribieron en el
 *    periodo o de quienes escribieron días antes?
 * Las ventas llegan ya resueltas (dashboard-sales.ts) y con su anuncio atribuido.
 */

export interface AdTouchRow {
  customerId: string;
  adSourceId: string | null;
  adTitle: string | null;
  createdAt: Date;
}

/** Venta del periodo con su anuncio ya atribuido y el monto ya filtrado por producto. */
export interface AdSaleRow {
  key: string;
  customerId: string | null;
  at: Date;
  amount: number;
  adSourceId: string | null;
  adTitle: string | null;
}

export interface AdPerson {
  customerId: string;
  wroteAt: Date;
  /** Ya era contacto antes del periodo. */
  isReturning: boolean;
  /** Primera compra posterior a escribir (null = aún no compra). */
  boughtAt: Date | null;
  amount: number | null;
  hoursToBuy: number | null;
}

/** Venta del periodo de alguien que escribió ANTES del periodo. */
export interface AdEarlierSale {
  key: string;
  customerId: string | null;
  at: Date;
  amount: number;
}

export interface AdBucket {
  adSourceId: string | null;
  adTitle: string | null;
  people: Map<string, AdPerson>;
  sales: number;
  revenue: number;
  salesFromPeriodLeads: number;
  revenueFromPeriodLeads: number;
  earlier: AdEarlierSale[];
}

export interface AdRow {
  adSourceId: string | null;
  adTitle: string | null;
  description: string | null;
  productName: string | null;
  leads: number;
  returningLeads: number;
  buyers: number;
  pendingLeads: number;
  sales: number;
  revenue: number;
  salesFromPeriodLeads: number;
  revenueFromPeriodLeads: number;
  salesFromEarlierLeads: number;
  revenueFromEarlierLeads: number;
  conversionRate: number | null;
  avgHoursToBuy: number | null;
  revenuePerLead: number | null;
}

export interface AdSummary {
  leads: { value: number; prev: number };
  buyers: number;
  pendingLeads: number;
  conversionRate: number | null;
  sales: number;
  revenue: number;
  salesFromPeriodLeads: number;
  revenueFromPeriodLeads: number;
  salesFromEarlierLeads: number;
  revenueFromEarlierLeads: number;
  avgHoursToBuy: number | null;
  revenuePerLead: number | null;
  avgTicket: number | null;
  /** % de las ventas del periodo que vienen de anuncios. */
  adsShareOfSales: number | null;
  bestAd: { adSourceId: string; name: string; leads: number; buyers: number; conversionRate: number | null } | null;
  adsWithoutSales: number;
  adsCount: number;
}

export const ORGANIC_KEY = "__sin_anuncio__";
const HOUR_MS = 60 * 60 * 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => Math.round(n * 10000) / 100;

export const adKeyOf = (adSourceId: string | null) => adSourceId ?? ORGANIC_KEY;

export interface AdCohortInput {
  /** Clics del periodo (ya filtrados por producto), en orden de fecha. */
  touches: AdTouchRow[];
  /** Contactos creados en el periodo. */
  newContacts: Array<{ id: string; createdAt: Date; adSourceId: string | null }>;
  /** Ventas del periodo con anuncio atribuido. */
  periodSales: AdSaleRow[];
  /** Compras de cada cliente (todas las conocidas hasta hoy), en orden de fecha. */
  purchasesByCustomer: Map<string, Array<{ at: number; amount: number }>>;
  /** Holgura entre el reloj del chat y el de la pasarela. */
  slackMs: number;
  /** Filas que no son anuncios (tienda web, pagos sin cliente): no tienen personas. */
  specialKeys?: string[];
}

/** Agrupa personas y ventas por anuncio. */
export function collectAdCohort(input: AdCohortInput): Map<string, AdBucket> {
  const { touches, newContacts, periodSales, purchasesByCustomer, slackMs } = input;
  const buckets = new Map<string, AdBucket>();
  const bucketFor = (adSourceId: string | null, adTitle: string | null): AdBucket => {
    const key = adKeyOf(adSourceId);
    let b = buckets.get(key);
    if (!b) {
      b = { adSourceId, adTitle, people: new Map(), sales: 0, revenue: 0, salesFromPeriodLeads: 0, revenueFromPeriodLeads: 0, earlier: [] };
      buckets.set(key, b);
    }
    if (!b.adTitle && adTitle) b.adTitle = adTitle;
    return b;
  };
  const firstPurchaseSince = (customerId: string, since: Date) => {
    const limit = since.getTime() - slackMs;
    return (purchasesByCustomer.get(customerId) ?? []).find((p) => p.at >= limit) ?? null;
  };
  const personOf = (customerId: string, wroteAt: Date, isReturning: boolean): AdPerson => {
    const p = firstPurchaseSince(customerId, wroteAt);
    return {
      customerId,
      wroteAt,
      isReturning,
      boughtAt: p ? new Date(p.at) : null,
      amount: p ? r2(p.amount) : null,
      hoursToBuy: p ? r1(Math.max(0, p.at - wroteAt.getTime()) / HOUR_MS) : null,
    };
  };

  // Personas: el primer clic del periodo de cada una en cada anuncio.
  const createdInPeriod = new Set(newContacts.map((c) => c.id));
  const touched = new Set<string>();
  for (const t of touches) {
    touched.add(t.customerId);
    const b = bucketFor(t.adSourceId, t.adTitle);
    if (b.people.has(t.customerId)) continue;
    b.people.set(t.customerId, personOf(t.customerId, t.createdAt, !createdInPeriod.has(t.customerId)));
  }
  // Sin anuncio: contactos nuevos del periodo que no llegaron desde ninguno.
  for (const c of newContacts) {
    if (c.adSourceId || touched.has(c.id)) continue;
    bucketFor(null, null).people.set(c.id, personOf(c.id, c.createdAt, false));
  }

  // Ventas del periodo: de quienes escribieron en el periodo o de días anteriores.
  for (const s of periodSales) {
    const b = bucketFor(s.adSourceId, s.adTitle);
    b.sales += 1;
    b.revenue += s.amount;
    const person = s.customerId ? b.people.get(s.customerId) : undefined;
    if (person && person.wroteAt.getTime() - slackMs <= s.at.getTime()) {
      b.salesFromPeriodLeads += 1;
      b.revenueFromPeriodLeads += s.amount;
    } else {
      b.earlier.push({ key: s.key, customerId: s.customerId, at: s.at, amount: r2(s.amount) });
    }
  }
  return buckets;
}

/** Filas de la tabla, ordenadas por lo cobrado y luego por leads. */
export function buildAdRows(
  buckets: Map<string, AdBucket>,
  describe: (adSourceId: string | null, adTitle: string | null) => { description?: string | null; productName?: string | null } | null,
): AdRow[] {
  return [...buckets.values()]
    .map((b) => {
      const entry = describe(b.adSourceId, b.adTitle);
      const people = [...b.people.values()];
      const leads = people.length;
      const bought = people.filter((p) => p.boughtAt);
      const buyers = bought.length;
      const hours = bought.map((p) => p.hoursToBuy ?? 0);
      return {
        adSourceId: b.adSourceId,
        adTitle: b.adTitle,
        description: entry?.description ?? null,
        productName: entry?.productName ?? null,
        leads,
        // De esos leads, cuántos ya eran contactos antes del periodo.
        returningLeads: people.filter((p) => p.isReturning).length,
        // De esos leads, cuántos ya compraron (después de escribir).
        buyers,
        pendingLeads: leads - buyers,
        // Ventas e ingresos del periodo atribuidos a este anuncio.
        sales: b.sales,
        revenue: r2(b.revenue),
        salesFromPeriodLeads: b.salesFromPeriodLeads,
        revenueFromPeriodLeads: r2(b.revenueFromPeriodLeads),
        salesFromEarlierLeads: b.sales - b.salesFromPeriodLeads,
        revenueFromEarlierLeads: r2(b.revenue - b.revenueFromPeriodLeads),
        // Conversión de cohorte: compraron / leads. Nunca pasa de 100 %.
        conversionRate: leads > 0 ? pct(buyers / leads) : null,
        avgHoursToBuy: buyers > 0 ? r1(hours.reduce((a, h) => a + h, 0) / buyers) : null,
        revenuePerLead: leads > 0 ? r2(b.revenueFromPeriodLeads / leads) : null,
      };
    })
    .sort((x, y) => y.revenue - x.revenue || y.leads - x.leads);
}

/** Resumen de los anuncios reales (sin orgánico ni filas especiales). */
export function summarizeAds(rows: AdRow[], buckets: Map<string, AdBucket>, opts: { leadsPrev: number; specialKeys: string[] }): AdSummary {
  const isAd = (r: { adSourceId: string | null }) => !!r.adSourceId && !opts.specialKeys.includes(r.adSourceId);
  const ads = rows.filter(isAd);
  const sum = (f: (r: AdRow) => number) => ads.reduce((a, r) => a + f(r), 0);
  const leads = sum((r) => r.leads);
  const buyers = sum((r) => r.buyers);
  const sales = sum((r) => r.sales);
  const revenue = r2(sum((r) => r.revenue));
  const salesFromPeriodLeads = sum((r) => r.salesFromPeriodLeads);
  const revenueFromPeriodLeads = r2(sum((r) => r.revenueFromPeriodLeads));
  const totalSales = rows.reduce((a, r) => a + r.sales, 0);

  const hours: number[] = [];
  for (const b of buckets.values()) {
    if (!isAd(b)) continue;
    for (const p of b.people.values()) if (p.boughtAt) hours.push(p.hoursToBuy ?? 0);
  }

  // Mejor anuncio: mayor conversión con al menos 3 leads; si ninguno llega, el de más compradores.
  const sellers = ads.filter((r) => r.buyers > 0);
  const solid = sellers.filter((r) => r.leads >= 3);
  const best = (solid.length ? solid : sellers)
    .slice()
    .sort((x, y) => (solid.length ? (y.conversionRate ?? 0) - (x.conversionRate ?? 0) : 0) || y.buyers - x.buyers || y.revenue - x.revenue)[0];

  return {
    leads: { value: leads, prev: opts.leadsPrev },
    buyers,
    pendingLeads: leads - buyers,
    conversionRate: leads > 0 ? pct(buyers / leads) : null,
    sales,
    revenue,
    salesFromPeriodLeads,
    revenueFromPeriodLeads,
    salesFromEarlierLeads: sales - salesFromPeriodLeads,
    revenueFromEarlierLeads: r2(revenue - revenueFromPeriodLeads),
    avgHoursToBuy: hours.length ? r1(hours.reduce((a, h) => a + h, 0) / hours.length) : null,
    revenuePerLead: leads > 0 ? r2(revenueFromPeriodLeads / leads) : null,
    avgTicket: sales > 0 ? r2(revenue / sales) : null,
    adsShareOfSales: totalSales > 0 ? pct(sales / totalSales) : null,
    bestAd: best
      ? {
          adSourceId: best.adSourceId as string,
          name: best.description ?? best.adTitle ?? (best.adSourceId as string),
          leads: best.leads,
          buyers: best.buyers,
          conversionRate: best.conversionRate,
        }
      : null,
    adsWithoutSales: ads.filter((r) => r.leads > 0 && r.buyers === 0).length,
    adsCount: ads.length,
  };
}

/** Leads del periodo anterior con la misma cuenta: personas distintas por anuncio. */
export function countAdLeads(touches: AdTouchRow[]): number {
  const seen = new Set<string>();
  for (const t of touches) if (t.adSourceId) seen.add(`${t.adSourceId}|${t.customerId}`);
  return seen.size;
}
