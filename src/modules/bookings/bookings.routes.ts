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
  getCalendarFeedController,
  regenerateCalendarFeedController,
  setCalendarFeedController,
} from "./bookings.controller";

const router = Router();

router.use(requireAuth);

router.get("/", listBookingsController);
router.post("/", createBookingController);
router.get("/availability", availabilityController);
// Calendario suscrito (ICS) del dueño.
router.get("/calendar-feed", getCalendarFeedController);
router.post("/calendar-feed/regenerate", regenerateCalendarFeedController);
router.put("/calendar-feed", setCalendarFeedController);
router.post("/:id/status", updateBookingStatusController);
router.put("/:id/reschedule", rescheduleBookingController);
router.delete("/:id", deleteBookingController);

router.get("/blocks/list", listBlocksController);
router.post("/blocks", createBlockController);
router.delete("/blocks/:id", deleteBlockController);

export default router;
