import { z } from "zod";

export const flowTriggerSchema = z.object({
  onAnyMessage: z.boolean().default(false),
  keywords: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  onFirstMessageOfDay: z.boolean().default(false),
  onFirstMessageEver: z.boolean().default(false),
  reactivationMinutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
});

const detectModeSchema = z.enum(["contains", "equals", "starts_with", "ends_with"]);

const positionSchema = z.object({ x: z.number(), y: z.number() });

// data por tipo (validación estructural; la lógica vive en flow-validation)
const sendTextData = z.object({
  text: z.string().max(4000).default(""),
  saveVariable: z.string().trim().max(40).optional(),
});

const sendMediaData = z.object({
  mediaUrl: z.string().max(2000).default(""),
  fileName: z.string().max(255).optional(),
  caption: z.string().max(4000).optional(),
  saveVariable: z.string().trim().max(40).optional(),
});

const answersData = z.object({
  message: z.string().max(4000).default(""),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().max(100).default(""),
        detectText: z.string().max(200).default(""),
        detectMode: detectModeSchema.default("contains"),
      }),
    )
    .max(15)
    .default([]),
  repeatOnNoMatch: z.boolean().default(false),
  noMatchMessage: z.string().max(2000).optional(),
  saveVariable: z.string().trim().max(40).optional(),
  timeoutMinutes: z.number().int().min(0).max(60 * 24 * 7).optional(),
});

const listData = z.object({
  title: z.string().max(120).optional(),
  body: z.string().max(4000).default(""),
  footer: z.string().max(300).optional(),
  sections: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().max(100).default(""),
        options: z
          .array(
            z.object({
              id: z.string().min(1),
              label: z.string().max(120).default(""),
              description: z.string().max(300).optional(),
            }),
          )
          .max(20)
          .default([]),
      }),
    )
    .max(10)
    .default([]),
  repeatOnNoMatch: z.boolean().default(false),
  noMatchMessage: z.string().max(2000).optional(),
  saveVariable: z.string().trim().max(40).optional(),
  timeoutMinutes: z.number().int().min(0).max(60 * 24 * 7).optional(),
});

const flowControlData = z.object({
  action: z.enum(["restart", "transfer"]).optional(),
  targetFlowId: z.string().uuid().optional(),
});

const handoffData = z.object({
  clientText: z.string().max(2000).optional(),
  notifyText: z.string().max(1000).optional(),
});

const reminderData = z.object({
  minutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
  message: z.string().max(2000).default(""),
});

const crmMoveData = z.object({
  crmId: z.string().uuid().optional(),
  crmColumnId: z.string().uuid().optional(),
  crmColumnName: z.string().max(120).optional(),
});

const crmTagsData = z.object({
  tagIds: z.array(z.string().uuid()).max(50).default([]),
});

const conditionData = z
  .object({
    source: z.enum(["variable", "tag", "purchased"]).default("variable"),
    variable: z.string().trim().max(40).optional(),
    operator: z.enum(["equals", "contains", "not_empty", "empty"]).optional(),
    value: z.string().max(500).optional(),
    tagId: z.string().uuid().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.source === "variable") {
      if (!data.variable?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["variable"], message: "Variable requerida" });
      }
      if (!data.operator) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["operator"], message: "Operador requerido" });
      }
    }
    if (data.source === "tag" && !data.tagId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tagId"], message: "Etiqueta requerida" });
    }
  });

const waitData = z.object({
  seconds: z.number().int().min(1).max(120).default(5),
});

const questionData = z.object({
  message: z.string().max(2000).default(""),
  varType: z.enum(["text", "number", "email", "phone"]).default("text"),
  saveVariable: z.string().trim().max(40).default(""),
  invalidMessage: z.string().max(2000).optional(),
  timeoutMinutes: z.number().int().min(0).max(60 * 24 * 7).optional(),
});

export const flowNodeSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("start"), position: positionSchema, data: z.object({}).passthrough() }),
  z.object({ id: z.string().min(1), type: z.literal("send-text"), position: positionSchema, data: sendTextData }),
  z.object({ id: z.string().min(1), type: z.literal("send-image"), position: positionSchema, data: sendMediaData }),
  z.object({ id: z.string().min(1), type: z.literal("send-video"), position: positionSchema, data: sendMediaData }),
  z.object({ id: z.string().min(1), type: z.literal("send-audio"), position: positionSchema, data: sendMediaData }),
  z.object({ id: z.string().min(1), type: z.literal("send-document"), position: positionSchema, data: sendMediaData }),
  z.object({ id: z.string().min(1), type: z.literal("answers"), position: positionSchema, data: answersData }),
  z.object({ id: z.string().min(1), type: z.literal("list"), position: positionSchema, data: listData }),
  z.object({ id: z.string().min(1), type: z.literal("flow-control"), position: positionSchema, data: flowControlData }),
  z.object({ id: z.string().min(1), type: z.literal("handoff"), position: positionSchema, data: handoffData }),
  z.object({ id: z.string().min(1), type: z.literal("reminder"), position: positionSchema, data: reminderData }),
  z.object({ id: z.string().min(1), type: z.literal("crm-move"), position: positionSchema, data: crmMoveData }),
  z.object({ id: z.string().min(1), type: z.literal("crm-add-tags"), position: positionSchema, data: crmTagsData }),
  z.object({ id: z.string().min(1), type: z.literal("crm-remove-tags"), position: positionSchema, data: crmTagsData }),
  z.object({ id: z.string().min(1), type: z.literal("condition"), position: positionSchema, data: conditionData }),
  z.object({ id: z.string().min(1), type: z.literal("wait"), position: positionSchema, data: waitData }),
  z.object({ id: z.string().min(1), type: z.literal("question"), position: positionSchema, data: questionData }),
]);

export const flowEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourceHandle: z.string().min(1).nullable().optional(),
    target: z.string().min(1),
    targetHandle: z.string().nullable().optional(),
  })
  .passthrough();

export const createFlowSchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(60),
  description: z.string().trim().max(200).optional(),
});

export const updateFlowSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
  trigger: flowTriggerSchema.optional(),
  nodes: z.array(flowNodeSchema).max(200).optional(),
  edges: z.array(flowEdgeSchema).max(500).optional(),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).nullable().optional(),
});

export const toggleFlowSchema = z.object({
  isActive: z.boolean(),
});

export const validateFlowSchema = z.object({
  nodes: z.array(flowNodeSchema).max(200),
  edges: z.array(flowEdgeSchema).max(500),
});
