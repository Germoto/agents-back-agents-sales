import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  listCustomersController,
  getCustomerController,
  updateCustomerController,
  listNotesController,
  createNoteController,
  deleteNoteController,
} from "./customers.controller";
import { updateCustomerSchema, createNoteSchema } from "./customers.schemas";

const router = Router();

router.use(requireAuth);

router.get("/", asyncHandler(listCustomersController));

// Notas internas por contacto (rutas estáticas antes de /:id — Express 5)
router.delete("/notes/:noteId", asyncHandler(deleteNoteController));
router.get("/:id/notes", asyncHandler(listNotesController));
router.post("/:id/notes", validate({ body: createNoteSchema }), asyncHandler(createNoteController));

// Ficha de contacto
router.get("/:id", asyncHandler(getCustomerController));
router.put("/:id", validate({ body: updateCustomerSchema }), asyncHandler(updateCustomerController));

export default router;
