import { NextFunction, Request, Response } from "express";
import { z } from "zod";

type Schema = {
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
};

export function validate(schema: Schema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (schema.body) {
      req.body = schema.body.parse(req.body);
    }

    if (schema.query) {
      const parsed = schema.query.parse(req.query) as Record<string, unknown>;
      // Express 5: req.query is a getter only. Mutate properties in place
      // instead of reassigning the whole object.
      for (const key of Object.keys(req.query)) {
        delete (req.query as Record<string, unknown>)[key];
      }
      Object.assign(req.query as Record<string, unknown>, parsed);
    }

    if (schema.params) {
      const parsed = schema.params.parse(req.params) as Record<string, unknown>;
      for (const key of Object.keys(req.params)) {
        delete (req.params as Record<string, unknown>)[key];
      }
      Object.assign(req.params as Record<string, unknown>, parsed);
    }

    next();
  };
}
