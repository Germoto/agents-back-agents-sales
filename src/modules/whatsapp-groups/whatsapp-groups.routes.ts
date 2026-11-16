import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import {
  addToGroupController,
  cancelPendingController,
  groupInfoController,
  groupMessagesController,
  groupReadController,
  groupSendController,
  groupStarController,
  removeParticipantsController,
  setGroupChatController,
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
  groupChatSchema,
  groupIdParams,
  groupInfoQuery,
  groupMessageParams,
  groupMessagesQuery,
  groupSendSchema,
  groupStarSchema,
  listMembersQuery,
  removeParticipantsSchema,
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

// Chat del grupo (apagado por defecto: se enciende grupo por grupo).
router.post("/:id/chat", validate({ params: groupIdParams, body: groupChatSchema }), asyncHandler(setGroupChatController));
router.get("/:id/info", validate({ params: groupIdParams, query: groupInfoQuery }), asyncHandler(groupInfoController));
router.get("/:id/messages", validate({ params: groupIdParams, query: groupMessagesQuery }), asyncHandler(groupMessagesController));
router.post("/:id/send", validate({ params: groupIdParams, body: groupSendSchema }), asyncHandler(groupSendController));
router.post("/:id/read", validate({ params: groupIdParams }), asyncHandler(groupReadController));
router.post("/:id/messages/:mid/star", validate({ params: groupMessageParams, body: groupStarSchema }), asyncHandler(groupStarController));
router.post("/:id/participants/remove", validate({ params: groupIdParams, body: removeParticipantsSchema }), asyncHandler(removeParticipantsController));

export default router;
