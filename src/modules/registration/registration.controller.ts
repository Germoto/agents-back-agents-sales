import type { Request, Response } from "express";
import { createPreRegistration, resendEmailCode, verifyEmailCode } from "./registration.service";
import { getRegistrationPublicConfig } from "../platform-config/platform-config.service";

const paramId = (req: Request) => {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] : value;
};

export async function createPreRegistrationController(req: Request, res: Response) {
  return res.status(201).json(await createPreRegistration(req.body));
}

export async function verifyPreRegistrationController(req: Request, res: Response) {
  return res.json(await verifyEmailCode(paramId(req), req.body.code));
}

export async function resendPreRegistrationCodeController(req: Request, res: Response) {
  return res.json(await resendEmailCode(paramId(req)));
}

/** Config pública del formulario de registro: modo (automático/manual), días de prueba y rubros habilitados. */
export async function registrationPublicConfigController(_req: Request, res: Response) {
  return res.json(await getRegistrationPublicConfig());
}
