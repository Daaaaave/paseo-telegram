import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  connectionSchema,
  groupAdmissionSchema,
  idSchema,
  policySchema,
  targetSchema,
} from "./config.ts";

const empty = z.object({}).strict();
const connectionId = z.object({ id: z.uuid() }).strict();
const groupChatId = z
  .string()
  .regex(/^-\d+$/)
  .refine(
    (value) => Number.isSafeInteger(Number(value)),
    "Invalid Telegram group ID",
  );
export const connectionViewSchema = z.object({
  config: connectionSchema,
  ownerId: z.number().nullable(),
  running: z.boolean(),
  lastError: z.string().nullable(),
  queued: z.number(),
  groupPrivacy: z.enum(["enabled", "disabled", "unknown"]).default("unknown"),
  groups: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      access: z
        .enum(["ready", "needs_admin", "not_member", "checking"])
        .default("checking"),
    }),
  ),
  pendingGroups: z
    .array(z.object({ id: z.string(), title: z.string() }))
    .default([]),
  conversations: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      agentId: z.string(),
      workspaceId: z.string().optional(),
      current: z.boolean(),
      active: z.boolean(),
    }),
  ),
});
export const listRpc = defineRpc({
  name: "telegram.list",
  input: empty,
  output: z.object({
    connections: z.array(connectionViewSchema),
    daemonConnected: z.boolean(),
    error: z.string().nullable(),
  }),
});
export const addRpc = defineRpc({
  name: "telegram.add",
  input: z
    .object({
      name: z.string().trim().min(1).max(80),
      token: z
        .string()
        .trim()
        .regex(/^\d{5,16}:[A-Za-z0-9_-]{20,160}$/),
    })
    .strict(),
  output: z.object({ id: z.uuid(), username: z.string() }),
});
export const saveRpc = defineRpc({
  name: "telegram.save",
  input: z
    .object({
      id: z.uuid(),
      revision: z.number().int().nonnegative(),
      name: z.string().trim().min(1).max(80),
      enabled: z.boolean(),
      target: targetSchema.nullable(),
      policy: policySchema.omit({ groupAdmission: true }).extend({
        groupAdmission: groupAdmissionSchema.optional(),
      }),
      bindings: z.record(z.string().regex(/^-?\d+:\d+$/), targetSchema),
    })
    .strict(),
  output: connectionSchema,
});
export const pairRpc = defineRpc({
  name: "telegram.pair",
  input: connectionId,
  output: z.object({ url: z.string(), expiresAt: z.number() }),
});
export const checkGroupsRpc = defineRpc({
  name: "telegram.check-groups",
  input: connectionId,
  output: empty,
});
export const disconnectRpc = defineRpc({
  name: "telegram.disconnect",
  input: connectionId,
  output: z.object({ removed: z.boolean() }),
});
export const revokeRpc = defineRpc({
  name: "telegram.revoke",
  input: z.object({ id: z.uuid(), chatId: groupChatId }).strict(),
  output: z.object({ revoked: z.boolean() }),
});
export const reviewRpc = defineRpc({
  name: "telegram.review",
  input: z
    .object({
      id: z.uuid(),
      chatId: groupChatId,
      approve: z.boolean(),
    })
    .strict(),
  output: z.object({ approved: z.boolean() }),
});
export const modelSchema = z.object({
  id: z.string(),
  label: z.string(),
  thinking: z.array(z.object({ id: z.string(), label: z.string() })),
});
export const choicesSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      workspaceId: z.string().nullable(),
    }),
  ),
  workspaces: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      directory: z.string(),
      project: z.string(),
    }),
  ),
  providers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      models: z.array(modelSchema),
      modes: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
  bots: z.array(z.object({ id: z.string(), name: z.string() })),
  botsAvailable: z.boolean(),
  botsError: z.string().nullable(),
});
export const choicesRpc = defineRpc({
  name: "telegram.choices",
  input: empty,
  output: choicesSchema,
});
export type ConnectionView = z.output<typeof connectionViewSchema>;
export type Choices = z.output<typeof choicesSchema>;
