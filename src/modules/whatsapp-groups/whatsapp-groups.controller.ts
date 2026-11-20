import { Request, Response } from "express";
import {
  cancelPending,
  enqueueGroupAdd,
  groupAddUsage,
  loadGroupPacing,
  saveGroupPacing,
  saveInviteMessage,
  saveInviteLink,
  loadGroupPause,
  resumeAccount,
  DEFAULT_GROUP_PACING,
  GROUP_PACING_LIMITS,
  listAvailableGroups,
  listCustomerGroups,
  listMembers,
  listSavedGroups,
  refreshInvited,
  removeGroup,
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
  // Express 5 vuelve a leer la query en cada acceso: los números validados llegan como texto.
  const q = req.query as { filter?: string; search?: string; page?: string; pageSize?: string };
  return res.json(
    await listMembers(req.user!.companyId, String(req.params.id), {
      filter: q.filter,
      search: q.search,
      page: Math.max(1, Number(q.page) || 1),
      pageSize: Math.min(100, Math.max(1, Number(q.pageSize) || 25)),
    }),
  );
}

export async function addToGroupController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  const { customerIds: ids, dryRun } = req.body as { customerIds: string[]; dryRun?: boolean };
  // Un contacto elegido a mano entra como MANUAL; varios (selección del CRM) como LOTE,
  // al final de la cola. Ninguno se salta el ritmo: encolar no envía nada.
  const single = ids.length === 1;
  const result = await enqueueGroupAdd({
    companyId,
    groupId: String(req.params.id),
    customerIds: ids,
    source: single ? "MANUAL" : "LOTE",
    immediate: single,
    dryRun,
  });
  return res.json(result);
}

async function pacingPayload(companyId: string, pacing?: Awaited<ReturnType<typeof loadGroupPacing>>) {
  const [current, usage, pause] = await Promise.all([
    pacing ?? loadGroupPacing(companyId),
    groupAddUsage(companyId),
    loadGroupPause(companyId),
  ]);
  return {
    pacing: current,
    defaults: DEFAULT_GROUP_PACING,
    limits: GROUP_PACING_LIMITS,
    usage: { lastHour: usage.lastHour, lastDay: usage.lastDay, lastAt: usage.lastAt },
    pause: pause ? { until: pause.until, kind: pause.kind, reason: pause.reason } : null,
  };
}

export async function getPacingController(req: Request, res: Response) {
  return res.json(await pacingPayload(req.user!.companyId));
}

export async function savePacingController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  return res.json(await pacingPayload(companyId, await saveGroupPacing(companyId, req.body)));
}

export async function resumeAccountController(req: Request, res: Response) {
  const companyId = req.user!.companyId;
  await resumeAccount(companyId);
  return res.json(await pacingPayload(companyId));
}

export async function saveInviteLinkController(req: Request, res: Response) {
  return res.json(await saveInviteLink(req.user!.companyId, String(req.params.id), req.body.link));
}

export async function saveInviteMessageController(req: Request, res: Response) {
  return res.json(await saveInviteMessage(req.user!.companyId, String(req.params.id), req.body.message));
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
