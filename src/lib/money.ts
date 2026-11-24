/**
 * Monto en texto → número. Acepta "S/ 1,234.50", "1.234,50", "49,9", "10".
 * Con los dos separadores, el ÚLTIMO es el decimal; una coma sola seguida de 1-2
 * dígitos es decimal (si no, es separador de miles). Puro.
 */
export function parseMoney(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : 0;
  const s = String(raw ?? "").replace(/[^0-9.,]/g, "");
  if (!s) return 0;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma);
    normalized = `${s.slice(0, dec).replace(/[.,]/g, "")}.${s.slice(dec + 1)}`;
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    normalized = decimals >= 1 && decimals <= 2 && s.indexOf(",") === lastComma ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0 && s.indexOf(".") !== lastDot) {
    // Varios puntos: son miles ("1.234.567").
    normalized = s.replace(/\./g, "");
  } else {
    normalized = s;
  }
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}
