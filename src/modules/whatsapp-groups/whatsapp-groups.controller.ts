import { Request, Response } from "express";
import {
  cancelPending,
  enqueueGroupAdd,
  groupAddUsage,
  loadGroupPacing,
  saveGroupPacing,
  DEFAULT_GROUP_PACING,
  GROUP_PACING_LIMITS,
  listAvailableGroups,
  listCustomerGroups,
  listMembers,
  listSavedGroups,
  refreshInvited,
  removeGroup,
  resolveBuyers,
  resumeGroup,
  retryMembers,
  saveGroup,
} from "./whatsapp-groups.service";
import {
  getGroupDetail,
  listGroupMessages,
  markGroupRead,
  removeParticipants,
  sendGroupMessage,
  setGroupChat,
  starGroupMessage,
} from "./whatsapp-group-chat.service";

export async function listGroupsController(req: Request, res: Response) {
  return res.json(await listSavedGroups(req.user!.companyId));
}

export async function listAvailableGroupsController(req: Request, res: Response) {
  return res.json(await listAvailableGroups(req.user!.companyId));
}

export async function saveGroupController(req: Request, res: Response) {
  return res.status(201).json(await saveGroup(req.user!.companyId, req.body));
}

export async function removeGroupController(req: Request, res: Response) {
  await removeGroup(req.user!.companyId, String(req.params.id));
  return res.status(204).send();
}

export async function resumeGroupController(req: Request, res: Response) {
  return res.json(await resumeGroup(req.user!.companyId, String(req.params.id)));
}

export async function listMembersController(req: Request, res: Response) {
  const q = req.query as unknown as { filter?: string; search?: string; page: number; pageSize: number };
  return res.json(await listMembers(req.user!.companyId, String(req.params.id), q));
}

export async function addToGroupController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const { customerIds, productId, dryRun } = req.body as { customerIds?: string[]; productId?: string; dryRun?: boolean };
  const ids = productId ? await resolveBuyers(companyId, productId) : customerIds ?? [];
  // Un solo contacto elegido a mano va al momento; el resto, a ritmo de lote.
  const single = !productId && ids.length === 1;
  const result = await enqueueGroupAdd({
    companyId,
    groupId: String(req.params.id),
    customerIds: ids,
    source: single ? "MANUAL" : "LOTE",
    immediate: single,
    force: single,
    dryRun,
  });
  return res.json(result);
}

async function pacingPayload(companyId: string, pacing?: Awaited<ReturnType<typeof loadGroupPacing>>) {
  const [current, usage] = await Promise.all([pacing ?? loadGroupPacing(companyId), groupAddUsage(companyId)]);
  return {
    pacing: current,
    defaults: DEFAULT_GROUP_PACING,
    limits: GROUP_PACING_LIMITS,
    usage: { lastHour: usage.lastHour, lastDay: usage.lastDay },
  };
}

export async function getPacingController(req: Request, res: Response) {
  return res.json(await pacingPayload(req.user!.companyId));
}

export async function savePacingController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  return res.json(await pacingPayload(companyId, await saveGroupPacing(companyId, req.body)));
}

export async function retryMembersController(req: Request, res: Response) {
  return res.json(await retryMembers(req.user!.companyId, String(req.params.id), req.body.memberIds));
}

export async function cancelPendingController(req: Request, res: Response) {
  return res.json(await cancelPending(req.user!.companyId, String(req.params.id)));
}

export async function refreshInvitedController(req: Request, res: Response) {
  return res.json(await refreshInvited(req.user!.companyId, String(req.params.id)));
}

export async function listCustomerGroupsController(req: Request, res: Response) {
  return res.json(await listCustomerGroups(req.user!.companyId, String(req.params.customerId)));
}

// ── Chat del grupo ──────────────────────────────────────────────────────────

export async function setGroupChatController(req: Request, res: Response) {
  return res.json(await setGroupChat(req.user!.companyId, String(req.params.id), req.body.enabled));
}

export async function groupInfoController(req: Request, res: Response) {
  return res.json(
    await getGroupDetail(req.user!.companyId, String(req.params.id), { refresh: req.query.refresh === "1" }),
  );
}

export async function groupMessagesController(req: Request, res: Response) {
  const q = req.query as { before?: string; limit?: number; starred?: string };
  return res.json(
    await listGroupMessages(req.user!.companyId, String(req.params.id), {
      before: q.before ?? null,
      limit: q.limit ? Number(q.limit) : undefined,
      starred: q.starred === "1",
    }),
  );
}

export async function groupSendController(req: Request, res: Response) {
  return res.status(201).json(await sendGroupMessage(req.user!.companyId, String(req.params.id), req.body, "PANEL"));
}

export async function groupReadController(req: Request, res: Response) {
  return res.json(await markGroupRead(req.user!.companyId, String(req.params.id)));
}

export async function groupStarController(req: Request, res: Response) {
  return res.json(
    await starGroupMessage(req.user!.companyId, String(req.params.id), String(req.params.mid), req.body.starred),
  );
}

export async function removeParticipantsController(req: Request, res: Response) {
  return res.json(await removeParticipants(req.user!.companyId, String(req.params.id), req.body.phones));
}
