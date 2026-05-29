export interface AppErrorOptions {
  code?: string;
  errors?: { field: string; message: string }[];
  details?: unknown;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly errors?: { field: string; message: string }[];
  public readonly details?: unknown;

  constructor(message: string, statusCode = 400, options?: AppErrorOptions | unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;

    // Retrocompat: si options tiene { code | errors | details } se trata como AppErrorOptions.
    // En caso contrario (cualquier otro valor, ej: string o array) va a details legacy.
    if (
      options !== null &&
      options !== undefined &&
      typeof options === "object" &&
      !Array.isArray(options) &&
      ("code" in (options as object) ||
        "errors" in (options as object) ||
        "details" in (options as object))
    ) {
      const o = options as AppErrorOptions;
      this.code = o.code;
      this.errors = o.errors;
      this.details = o.details;
    } else {
      this.details = options;
    }
  }
}
