import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@prisma/client";
import { AppError } from "../lib/app-error";

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(new AppError("Usuario no autorizado", 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(new AppError("No tienes permisos para realizar esta accion", 403));
    }

    return next();
  };
}
