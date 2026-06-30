/**
 * Importación de destinatarios desde una hoja de cálculo (.xlsx/.xls/.csv).
 *
 * Usa multer en memoria (no toca disco) y SheetJS para parsear. Detecta la columna
 * de teléfono por cabecera (tel/phone/whatsapp/número/celular) y, opcionalmente, la
 * de nombre; si no hay cabeceras reconocibles, toma la primera columna como teléfono.
 * Devuelve contactos normalizados {phone, name?} deduplicados por dígitos.
 */

import { Request } from "express";
import multer, { FileFilterCallback } from "multer";
import * as XLSX from "xlsx";
import { env } from "../../config/env";
import { AppError } from "../../lib/app-error";

const ALLOWED_EXT = new Set(["xlsx", "xls", "csv"]);
const ALLOWED_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "text/plain",
  "application/octet-stream", // algunos navegadores envían csv/xlsx así
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = extOf(file.originalname);
  if (ALLOWED_EXT.has(ext) || ALLOWED_MIME.has(file.mimetype)) {
    return cb(null, true);
  }
  cb(new AppError("Formato no soportado. Usa .xlsx, .xls o .csv", 415));
}

export const importUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
}).single("file");

export interface ImportedContact {
  phone: string;
  name?: string;
}

export interface ImportResult {
  contacts: ImportedContact[];
  total: number;
  skipped: number;
}

const PHONE_HEADERS = ["telefono", "teléfono", "phone", "whatsapp", "wa", "numero", "número", "celular", "movil", "móvil", "tel"];
const NAME_HEADERS = ["nombre", "name", "cliente", "contacto"];

function normHeader(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Normaliza un teléfono a formato +<dígitos>. Devuelve null si es inválido. */
function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export function parseSpreadsheet(buffer: Buffer): ImportResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch {
    throw new AppError("No se pudo leer el archivo. Verifica que sea un .xlsx/.csv válido", 400);
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new AppError("El archivo no tiene hojas", 400);
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" });
  if (!rows.length) return { contacts: [], total: 0, skipped: 0 };

  // ¿La primera fila es cabecera? Lo es si alguna celda coincide con un header conocido.
  const first = rows[0] as unknown[];
  const headerNorm = first.map(normHeader);
  let phoneCol = headerNorm.findIndex((h) => PHONE_HEADERS.includes(h));
  let nameCol = headerNorm.findIndex((h) => NAME_HEADERS.includes(h));
  const hasHeader = phoneCol !== -1 || nameCol !== -1;
  if (phoneCol === -1) phoneCol = 0; // sin cabecera reconocible: primera columna = teléfono

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const seen = new Set<string>();
  const contacts: ImportedContact[] = [];
  let skipped = 0;

  for (const row of dataRows) {
    const arr = Array.isArray(row) ? row : [];
    const phone = normalizePhone(arr[phoneCol]);
    if (!phone) {
      skipped++;
      continue;
    }
    const key = phone.replace(/\D/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const name = nameCol !== -1 ? String(arr[nameCol] ?? "").trim() : "";
    contacts.push({ phone, ...(name ? { name } : {}) });
  }

  return { contacts, total: contacts.length, skipped };
}
