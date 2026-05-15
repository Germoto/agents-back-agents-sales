import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/app-error";

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      details: error.details,
    });
  }

  if (error instanceof ZodError) {
    return res.status(422).json({
      success: false,
      message: "Error de validacion",
      details: error.flatten(),
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
