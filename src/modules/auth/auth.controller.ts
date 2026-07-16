import { Request, Response } from "express";
import { login, getAuthenticatedUser, updateUiTheme } from "./auth.service";

export async function loginController(req: Request, res: Response) {
  // `identifier` (celular o usuario); `phone` es el alias legacy del front anterior.
  const result = await login(req.body.identifier ?? req.body.phone, req.body.password);
  return res.json(result);
}

export async function meController(req: Request, res: Response) {
  const user = await getAuthenticatedUser(req.user!.id);
  return res.json(user);
}

export async function updateUiThemeController(req: Request, res: Response) {
  const result = await updateUiTheme(req.user!.id, req.body);
  return res.json(result);
}
