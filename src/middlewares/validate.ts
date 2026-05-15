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
      req.query = schema.query.parse(req.query) as Request["query"];
    }

    if (schema.params) {
      req.params = schema.params.parse(req.params) as Request["params"];
    }

    next();
  };
}
