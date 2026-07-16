import rateLimit from "express-rate-limit";

/**
 * Rate limiter para endpoints públicos (pre-registro). Requiere
 * `app.set("trust proxy", 1)` para agrupar por la IP real del cliente.
 */
export function makeRateLimiter(options: { windowMs: number; max: number; message: string }) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ message: options.message });
    },
  });
}
