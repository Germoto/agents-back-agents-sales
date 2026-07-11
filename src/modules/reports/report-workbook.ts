import ExcelJS from "exceljs";
import type { getDashboardExportData } from "../dashboard/dashboard.service";

/**
 * Genera el .xlsx del dashboard SERVER-SIDE para los reportes automáticos.
 * Port 1:1 del builder del panel (frontend src/shared/lib/dashboard-export.ts):
 * mismas 9 pestañas y estilo, con acento fijo (aquí no hay tema del usuario) y
 * sin las partes de browser (download/Blob). Si cambias las pestañas allá,
 * replica el cambio acá.
 */

export type DashboardExportPayload = Awaited<ReturnType<typeof getDashboardExportData>>;

type Delta = { value: number; prev: number };
type Cell = string | number;

type SheetSpec = {
  name: string; // ≤31 chars, sin \ / ? * [ ] :
  title: string;
  subtitle: string;
  headers: string[];
  rows: Cell[][];
  widths: number[];
  moneyCols?: number[]; // índices 1-based con formato #,##0.00
};

const ACCENT_ARGB = "FF6366F1";
const GRAY = "FF6B7280";
const BORDER_GRAY = "FFE5E7EB";

const VALIDATION_LABELS: Record<string, string> = { AUTO: "Automática", MANUAL: "Manual" };
const RECEIPT_STATUS_LABELS: Record<string, string> = { PENDIENTE: "Pendiente", EN_REVISION: "En revisión" };
const CONVERSATION_STATUS_LABELS: Record<string, string> = { OPEN: "Abierta", HUMAN: "Humano", CLOSED: "Cerrada" };
const REMINDER_TYPE_LABELS: Record<string, string> = {
  ABANDONED_CART: "Carrito abandonado",
  LEFT_ON_READ: "Dejado en visto",
  OFFER_COUNTDOWN: "Oferta por vencer",
  POST_SALE: "Post-venta",
  CUSTOM: "Personalizado",
};

const label = (map: Record<string, string>, value: string | null | undefined) =>
  value ? (map[value] ?? value) : "—";
const capitalize = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");
const yesNo = (v: boolean) => (v ? "Sí" : "No");

/** Variación vs. período anterior, con la misma semántica que el dashboard. */
function deltaLabel(d: Delta): string {
  if (d.prev === 0 && d.value === 0) return "—";
  if (d.prev === 0) return "+100%";
  const pct = Math.round(((d.value - d.prev) / Math.abs(d.prev)) * 100);
  const capped = Math.max(-999, Math.min(999, pct));
  return `${capped > 0 ? "+" : ""}${capped}%`;
}

function addTableSheet(wb: ExcelJS.Workbook, spec: SheetSpec) {
  const ws = wb.addWorksheet(spec.name.slice(0, 31));
  const cols = Math.max(spec.headers.length, 2);
  const colLetter = (n: number) => String.fromCharCode(64 + n); // 1→A (hojas de ≤26 cols)

  ws.mergeCells(`A1:${colLetter(cols)}1`);
  const title = ws.getCell("A1");
  title.value = spec.title;
  title.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  title.alignment = { vertical: "middle", horizontal: "left" };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_ARGB } };
  ws.getRow(1).height = 26;

  ws.mergeCells(`A2:${colLetter(cols)}2`);
  const sub = ws.getCell("A2");
  sub.value = spec.subtitle;
  sub.font = { italic: true, size: 10, color: { argb: GRAY } };

  const headerRowIdx = 4;
  const headerRow = ws.getRow(headerRowIdx);
  headerRow.values = spec.headers;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_ARGB } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = {
      top: { style: "thin", color: { argb: BORDER_GRAY } },
      bottom: { style: "thin", color: { argb: BORDER_GRAY } },
    };
  });
  headerRow.height = 18;

  if (spec.rows.length === 0) {
    const empty = ws.addRow(["Sin registros en el período"]);
    empty.getCell(1).font = { italic: true, color: { argb: GRAY } };
  } else {
    for (const row of spec.rows) ws.addRow(row);
  }

  spec.widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  for (const c of spec.moneyCols ?? []) ws.getColumn(c).numFmt = "#,##0.00";

  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to: { row: headerRowIdx, column: spec.headers.length },
  };
  ws.views = [{ state: "frozen", ySplit: headerRowIdx }];
  return ws;
}

export async function buildDashboardWorkbook(
  data: DashboardExportPayload,
  opts: { periodLabel: string },
): Promise<Buffer> {
  const { stats, meta } = data;
  const k = stats.kpis;
  const tz = meta.timezone;
  const fmtDate = (v: Date | string | null | undefined) =>
    v ? new Date(v).toLocaleString("es-PE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }) : "—";
  const rangeLabel = `${opts.periodLabel} (${stats.range.from} → ${stats.range.to})`;
  const productLabel = meta.productName ?? "Todos los productos";

  const wb = new ExcelJS.Workbook();

  // ---- 1. Resumen (meta + KPIs + embudo + flujos) ----
  {
    const ws = wb.addWorksheet("Resumen");
    ws.mergeCells("A1:D1");
    const title = ws.getCell("A1");
    title.value = `${meta.companyName} — Dashboard`;
    title.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    title.alignment = { vertical: "middle", horizontal: "left" };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_ARGB } };
    ws.getRow(1).height = 26;

    ws.mergeCells("A2:D2");
    const sub = ws.getCell("A2");
    sub.value = `Exportado ${fmtDate(meta.generatedAt)} · Zona horaria ${tz}`;
    sub.font = { italic: true, size: 10, color: { argb: GRAY } };

    const metaRows: Array<[string, string]> = [
      ["Período", rangeLabel],
      ["Producto", productLabel],
      ["Moneda", stats.currency],
    ];
    for (const [labelText, value] of metaRows) {
      const row = ws.addRow([]);
      row.getCell(1).value = labelText;
      row.getCell(1).font = { bold: true };
      ws.mergeCells(`B${row.number}:D${row.number}`);
      row.getCell(2).value = value;
    }

    const styleHeaderRow = (values: string[]) => {
      ws.addRow([]);
      const row = ws.addRow(values);
      row.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_ARGB } };
        cell.alignment = { vertical: "middle", horizontal: "left" };
      });
      row.height = 18;
      return row;
    };

    styleHeaderRow(["Indicador", "Valor", "Período anterior", "Variación"]);
    const money = (n: number) => ({ value: n, fmt: "#,##0.00" });
    const kpiRows: Array<[string, { value: number; fmt?: string } | number | string, number | string, string]> = [
      ["Ingresos", money(k.revenue.value), k.revenue.prev, deltaLabel(k.revenue)],
      ["Ventas", k.sales.value, k.sales.prev, deltaLabel(k.sales)],
      ["Ticket promedio", money(k.avgTicket.value), k.avgTicket.prev, deltaLabel(k.avgTicket)],
      ["Unidades vendidas", k.units.value, k.units.prev, deltaLabel(k.units)],
      ["Contactos nuevos", k.newContacts.value, k.newContacts.prev, deltaLabel(k.newContacts)],
      ["Conversaciones", k.conversations.value, k.conversations.prev, deltaLabel(k.conversations)],
      ["Tasa de conversión", `${k.conversionRate.value}%`, `${k.conversionRate.prev}%`, deltaLabel(k.conversionRate)],
      ["Comprobantes por revisar", k.pendingReceipts, "—", "—"],
      ["Aprobaciones automáticas", k.autoApprovals, "—", "—"],
      ["Aprobaciones manuales", k.manualApprovals, "—", "—"],
      ["Recordatorios enviados", k.remindersSent.value, k.remindersSent.prev, deltaLabel(k.remindersSent)],
      ["Leads que compraron", k.convertedLeads.value, k.convertedLeads.prev, deltaLabel(k.convertedLeads)],
    ];
    for (const [name, value, prev, delta] of kpiRows) {
      const row = ws.addRow([name, 0, prev, delta]);
      const valueCell = row.getCell(2);
      if (typeof value === "object") {
        valueCell.value = value.value;
        if (value.fmt) {
          valueCell.numFmt = value.fmt;
          const prevCell = row.getCell(3);
          if (typeof prev === "number") prevCell.numFmt = value.fmt;
        }
      } else {
        valueCell.value = value;
      }
    }

    styleHeaderRow(["Embudo", "Valor", "% del paso anterior", ""]);
    const pctOf = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
    ws.addRow(["Contactos nuevos", stats.funnel.contacts, "—"]);
    ws.addRow(["Conversaciones", stats.funnel.conversations, pctOf(stats.funnel.conversations, stats.funnel.contacts)]);
    ws.addRow(["Ventas", stats.funnel.sales, pctOf(stats.funnel.sales, stats.funnel.conversations)]);

    styleHeaderRow(["Flujos de chatbot", "Valor", "", ""]);
    ws.addRow(["Totales", stats.flows.total]);
    ws.addRow(["Activos", stats.flows.active]);

    [28, 20, 18, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  }

  const detailSubtitle = (count: number, singular: string, plural: string) =>
    `${count} ${count === 1 ? singular : plural} · ${rangeLabel} · Producto: ${productLabel}`;

  // ---- 2. Ventas ----
  addTableSheet(wb, {
    name: "Ventas",
    title: "Ventas (comprobantes aprobados)",
    subtitle: detailSubtitle(data.sales.length, "venta", "ventas"),
    headers: ["Fecha", "Cliente", "Teléfono", "Pagador", "Tel. pagador", "Método", "Monto", "Moneda", "Producto(s)", "Validación", "Cód. operación", "Referencia", "Origen", "Match"],
    rows: data.sales.map((s) => [
      fmtDate(s.date),
      s.customerName ?? "—",
      s.customerPhone ?? "—",
      s.payerName ?? "—",
      s.payerPhone ?? "—",
      capitalize(s.method),
      s.amount,
      s.currency,
      s.products,
      label(VALIDATION_LABELS, s.validationMode),
      s.operationCode ?? "—",
      s.reference ?? "—",
      s.source ?? "—",
      s.matchScore ?? "—",
    ]),
    widths: [17, 24, 16, 24, 16, 14, 12, 10, 32, 12, 15, 15, 12, 8],
    moneyCols: [7],
  });

  // ---- 3. Ingresos por día / mes ----
  const daily = stats.range.granularity === "daily";
  addTableSheet(wb, {
    name: daily ? "Ingresos por día" : "Ingresos por mes",
    title: daily ? "Ingresos por día" : "Ingresos por mes",
    subtitle: `${rangeLabel} · Producto: ${productLabel}`,
    headers: ["Fecha", "Etiqueta", "Ingresos", "Ventas"],
    rows: stats.series.map((p) => [p.date, p.label, p.total, p.count]),
    widths: [14, 14, 14, 10],
    moneyCols: [3],
  });

  // ---- 4. Top productos ----
  addTableSheet(wb, {
    name: "Top productos",
    title: "Productos más vendidos",
    subtitle: `Ranking global del período (ignora el filtro de producto) · ${rangeLabel}`,
    headers: ["Producto", "Ingresos", "Unidades"],
    rows: stats.topProducts.map((p) => [p.name, p.revenue, p.units]),
    widths: [36, 14, 12],
    moneyCols: [2],
  });

  // ---- 5. Métodos de pago ----
  const methodTotal = stats.paymentMethods.reduce((acc, m) => acc + m.count, 0);
  addTableSheet(wb, {
    name: "Métodos de pago",
    title: "Métodos de pago",
    subtitle: `${rangeLabel} · Producto: ${productLabel}`,
    headers: ["Método", "Pagos", "%"],
    rows: stats.paymentMethods.map((m) => [
      capitalize(m.method),
      m.count,
      methodTotal > 0 ? `${Math.round((m.count / methodTotal) * 100)}%` : "—",
    ]),
    widths: [22, 10, 8],
  });

  // ---- 6. Clientes nuevos ----
  addTableSheet(wb, {
    name: "Clientes nuevos",
    title: "Clientes nuevos",
    subtitle: detailSubtitle(data.newCustomers.length, "cliente", "clientes"),
    headers: ["Fecha", "Nombre", "Teléfono", "Email", "Origen del lead", "Producto de interés", "Compró"],
    rows: data.newCustomers.map((c) => [
      fmtDate(c.date),
      c.name ?? "—",
      c.phone,
      c.email ?? "—",
      c.leadSource ?? "—",
      c.interestedIn ?? "—",
      yesNo(c.purchased),
    ]),
    widths: [17, 26, 16, 26, 18, 28, 9],
  });

  // ---- 7. Comprobantes por revisar ----
  addTableSheet(wb, {
    name: "Comprobantes por revisar",
    title: "Comprobantes por revisar",
    subtitle: detailSubtitle(data.pending.length, "comprobante", "comprobantes"),
    headers: ["Fecha", "Estado", "Cliente", "Teléfono", "Pagador", "Monto esperado", "Moneda", "Método", "Origen", "Producto(s)"],
    rows: data.pending.map((p) => [
      fmtDate(p.date),
      label(RECEIPT_STATUS_LABELS, p.status),
      p.customerName ?? "—",
      p.customerPhone ?? "—",
      p.payerName ?? "—",
      p.amountExpected,
      p.currency,
      capitalize(p.method),
      p.source ?? "—",
      p.products || "—",
    ]),
    widths: [17, 12, 24, 16, 24, 14, 10, 14, 12, 32],
    moneyCols: [6],
  });

  // ---- 8. Recordatorios ----
  addTableSheet(wb, {
    name: "Recordatorios",
    title: "Recordatorios enviados",
    subtitle: `${data.reminders.length} enviado(s) · ${rangeLabel}`,
    headers: ["Enviado", "Tipo", "Cliente", "Teléfono", "Mensaje"],
    rows: data.reminders.map((r) => [
      fmtDate(r.sentAt),
      label(REMINDER_TYPE_LABELS, r.type),
      r.customerName ?? "—",
      r.customerPhone ?? "—",
      r.body,
    ]),
    widths: [17, 20, 24, 16, 70],
  });

  // ---- 9. Conversaciones ----
  addTableSheet(wb, {
    name: "Conversaciones",
    title: "Conversaciones iniciadas",
    subtitle: `${data.conversations.length} conversación(es) · ${rangeLabel}`,
    headers: ["Creada", "Cliente", "Teléfono", "Estado", "Bot pausado", "Último mensaje", "Cerrada"],
    rows: data.conversations.map((c) => [
      fmtDate(c.createdAt),
      c.customerName ?? "—",
      c.customerPhone ?? "—",
      label(CONVERSATION_STATUS_LABELS, c.status),
      yesNo(c.botPaused),
      fmtDate(c.lastMessageAt),
      fmtDate(c.closedAt),
    ]),
    widths: [17, 26, 16, 12, 12, 17, 17],
  });

  // El Buffer tipado de exceljs no es el de Node: normalizar para fs/nodemailer.
  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}
