/**
 * Catálogo ÚNICO de tipos de archivo "documento" que el sistema sube y envía.
 * La lista es la que acepta el gateway SMS Tools en /send/whatsapp con
 * type=document (document_type = extensión); todo lo que no sea imagen, video
 * o audio pasa por aquí (subida del panel, envío por WhatsApp, entrantes).
 */

import { env } from "../config/env";

/** Extensiones admitidas por el gateway (document_type). Ampliar aquí y nada más. */
export const DOCUMENT_EXTS = ["pdf", "xml", "xls", "xlsx", "doc", "docx", "zip", "rar", "7z", "txt", "csv", "pptx"] as const;
export type DocumentExt = (typeof DOCUMENT_EXTS)[number];

/** MIME canónico por extensión (para el part binario y para Meta). */
export const DOCUMENT_MIME: Record<DocumentExt, string> = {
  pdf: "application/pdf",
  xml: "application/xml",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  txt: "text/plain",
  csv: "text/csv",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Extensión por MIME, incluyendo las variantes que mandan los navegadores. */
const EXT_BY_MIME: Record<string, DocumentExt> = {
  "application/pdf": "pdf",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-zip": "zip",
  "application/vnd.rar": "rar",
  "application/x-rar-compressed": "rar",
  "application/x-rar": "rar",
  "application/x-7z-compressed": "7z",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/csv": "csv",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

/** Documentos que la Cloud API de Meta admite como `document` (el resto va como enlace). */
export const META_DOCUMENT_EXTS = new Set<string>(["txt", "xls", "xlsx", "doc", "docx", "ppt", "pptx", "pdf"]);

/** Tope de tamaño para documentos (MB). Imagen/video/audio siguen con MAX_UPLOAD_MB. */
export const MAX_DOCUMENT_MB = env.MAX_DOCUMENT_MB;
export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MB * 1024 * 1024;

/** Extensión en minúsculas (sin punto) de un nombre de archivo o URL; "" si no tiene. */
export function extOf(nameOrUrl: string): string {
  let s = nameOrUrl;
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
  } catch {
    /* no es URL: se trata como nombre */
  }
  const last = s.split("/").pop() ?? "";
  const m = last.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

export function isDocumentExt(ext: string): ext is DocumentExt {
  return (DOCUMENT_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/** Extensión de documento a partir de un MIME (variantes de navegador incluidas), o null. */
export function documentExtFromMime(mime: string | null | undefined): DocumentExt | null {
  if (!mime) return null;
  const clean = mime.split(";")[0].trim().toLowerCase();
  return EXT_BY_MIME[clean] ?? null;
}

/**
 * Decide si un archivo subido es un documento admitido: por extensión del nombre
 * (lo fiable: el MIME de zip/rar/7z cambia según el navegador y a veces llega
 * como application/octet-stream) o, si el nombre no trae extensión, por MIME.
 */
export function documentExtOfUpload(originalName: string, mime: string): DocumentExt | null {
  const ext = extOf(originalName);
  if (isDocumentExt(ext)) return ext;
  return documentExtFromMime(mime);
}

/** Texto para mensajes de error/ayuda: "pdf, xml, xls, …". */
export const DOCUMENT_EXTS_LABEL = DOCUMENT_EXTS.join(", ");
