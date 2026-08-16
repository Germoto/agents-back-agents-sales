/**
 * Rutas del conector MCP.
 * - Público (auth por token en el path): POST /api/mcp/:token — protocolo MCP.
 * - Panel (JWT): /api/mcp-config — activar/desactivar, ver URL, regenerar token.
 */

import { Router, json } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { mcpHttpController } from "./mcp.controller";
import { getMcpConfig, updateMcpConfig, regenerateMcpToken } from "./mcp.service";

export const mcpPublicRoutes = Router();
// Límite propio: los tools/call con textos largos superan el default de Express.
mcpPublicRoutes.use(json({ limit: "2mb" }));
mcpPublicRoutes.all("/:token", asyncHandler(mcpHttpController));

const updateSchema = z.object({ enabled: z.boolean() });

export const mcpConfigRoutes = Router();
mcpConfigRoutes.use(requireAuth);
mcpConfigRoutes.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => res.json(await getMcpConfig(req.user!.companyId))),
);
mcpConfigRoutes.put(
  "/",
  validate({ body: updateSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    res.json(await updateMcpConfig(req.user!.companyId, req.body as { enabled: boolean })),
  ),
);
mcpConfigRoutes.post(
  "/regenerate-token",
  asyncHandler(async (req: Request, res: Response) => res.json(await regenerateMcpToken(req.user!.companyId))),
);
