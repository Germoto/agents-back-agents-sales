import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/app-error";

export function optionalBotApiKey(req: Request, _res: Response, next: NextFunction) {
  if (!env.BOT_CONFIG_API_KEY) {
    return next();
  }

  const apiKey = req.header("x-api-key");

  if (apiKey !== env.BOT_CONFIG_API_KEY) {
    return next(new AppError("x-api-key invalida", 401));
  }

  next();
}
