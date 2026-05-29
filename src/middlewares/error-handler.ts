import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/app-error";

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.errors !== undefined ? { errors: error.errors } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  }

  if (error instanceof ZodError) {
    const errors = error.issues.map((i) => ({
      field: i.path.join(".") || "(root)",
      message: i.message,
    }));
    return res.status(422).json({
      success: false,
      message: "Validación fallida",
      code: "VALIDATION_FAILED",
      errors,
      details: error.flatten(), // retrocompat con frontend
    });
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    return res.status(409).json({
      success: false,
      message: "Conflicto de datos",
      details: String((error as { message?: string }).message ?? ""),
    });
  }

  console.error(error);
  return res.status(500).json({
    success: false,
    message: "Error interno del servidor",
  });
}
