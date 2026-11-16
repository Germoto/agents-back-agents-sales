import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  addToGroupController,
  cancelPendingController,
  listAvailableGroupsController,
  listCustomerGroupsController,
  listGroupsController,
  listMembersController,
  refreshInvitedController,
  removeGroupController,
  resumeGroupController,
  retryMembersController,
  saveGroupController,
} from "./whatsapp-groups.controller";
import {
  addToGroupSchema,
  customerIdParams,
  groupIdParams,
  listMembersQuery,
  retryMembersSchema,
  saveGroupSchema,
} from "./whatsapp-groups.schemas";

const router = Router();

router.use(requireAuth);

// Grupos guardados del negocio (con contadores) y grupos de la cuenta en vivo.
router.get("/", asyncHandler(listGroupsController));
router.get("/available", asyncHandler(listAvailableGroupsController));
router.post("/", validate({ body: saveGroupSchema }), asyncHandler(saveGroupController));
router.get("/customer/:customerId", validate({ params: customerIdParams }), asyncHandler(listCustomerGroupsController));
router.delete("/:id", validate({ params: groupIdParams }), asyncHandler(removeGroupController));
router.post("/:id/resume", validate({ params: groupIdParams }), asyncHandler(resumeGroupController));

// Miembros y cola.
router.get("/:id/members", validate({ params: groupIdParams, query: listMembersQuery }), asyncHandler(listMembersController));
router.post("/:id/add", validate({ params: groupIdParams, body: addToGroupSchema }), asyncHandler(addToGroupController));
router.post("/:id/members/retry", validate({ params: groupIdParams, body: retryMembersSchema }), asyncHandler(retryMembersController));
router.post("/:id/members/cancel", validate({ params: groupIdParams }), asyncHandler(cancelPendingController));
router.post("/:id/refresh", validate({ params: groupIdParams }), asyncHandler(refreshInvitedController));

export default router;
