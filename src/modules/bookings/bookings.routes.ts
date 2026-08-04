/**
 * Agenda de citas del tenant (rubro SERVICE): listado/agenda, alta manual,
 * reagendar, estados, disponibilidad y bloqueos.
 */

import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import {
  availabilityController,
  createBlockController,
  createBookingController,
  deleteBlockController,
  deleteBookingController,
  listBlocksController,
  listBookingsController,
  rescheduleBookingController,
  updateBookingStatusController,
} from "./bookings.controller";

const router = Router();

router.use(requireAuth);

router.get("/", listBookingsController);
router.post("/", createBookingController);
router.get("/availability", availabilityController);
router.post("/:id/status", updateBookingStatusController);
router.put("/:id/reschedule", rescheduleBookingController);
router.delete("/:id", deleteBookingController);

router.get("/blocks/list", listBlocksController);
router.post("/blocks", createBlockController);
router.delete("/blocks/:id", deleteBlockController);

export default router;
