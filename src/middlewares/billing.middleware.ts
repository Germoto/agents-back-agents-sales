import type { NextFunction, Request, Response } from "express";
import type { PlanModule } from "@prisma/client";
import { AppError } from "../lib/app-error";
import { verifyAccessToken } from "../lib/jwt";
import { getEntitlements } from "../modules/billing/entitlements";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Guard de monetización para grupos de rutas del tenant. Se monta a nivel de
 * routes/index.ts DELANTE del router del módulo:
 *  - `billingGuard({ module })`: 403 MODULE_NOT_AVAILABLE si el paquete del
 *    tenant no incluye el módulo (todos los métodos).
 *  - `billingGuard()`: con la suscripción vencida (blocked) solo bloquea
 *    ESCRITURAS (403 SUBSCRIPTION_EXPIRED); las lecturas siguen (panel
 *    consultable, nunca read-only total).
 *
 * Decodifica el JWT por sí mismo (sin query a BD): los routers de módulo ya
 * corren su propio requireAuth después. Sin token o token inválido => next()
 * y el requireAuth interno responde su 401 habitual. SUPERADMIN pasa siempre.
 * Empresas LEGACY (sin suscripción) pasan siempre.
 */
export function billingGuard(opts?: { module?: PlanModule }) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith("Bearer ")) return next();

      let payload;
      try {
        payload = verifyAccessToken(header.slice("Bearer ".length));
      } catch {
        return next();
      }
      if (payload.role === "SUPERADMIN" || !payload.companyId) return next();

      const ent = await getEntitlements(payload.companyId);
      if (ent.legacy) return next();

      if (opts?.module && !ent.modules.includes(opts.module)) {
        return next(
          new AppError("Tu plan no incluye este módulo. Mejora tu paquete para activarlo.", 403, {
            code: "MODULE_NOT_AVAILABLE",
          }),
        );
      }

      if (ent.blocked && WRITE_METHODS.has(req.method)) {
        return next(
          new AppError("Tu suscripción venció. Renueva tu plan para continuar.", 403, {
            code: "SUBSCRIPTION_EXPIRED",
          }),
        );
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}
