import { Request, Response } from "express";
import { getBotConfig } from "./bot.service";
import { botConfigQuerySchema } from "./bot.schemas";

export async function getBotConfigController(req: Request, res: Response) {
  const query = botConfigQuerySchema.parse(req.query);
  const result = await getBotConfig(query.account, query.phone);
  return res.json(result);
}
