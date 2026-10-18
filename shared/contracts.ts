import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { connectionSchema, idSchema, policySchema, targetSchema } from "./config.ts";

const empty = z.object({}).strict();
const connectionId = z.object({ id: z.uuid() }).strict();
export const connectionViewSchema = z.object({
  config: connectionSchema, ownerId: z.number().nullable(), running: z.boolean(),
  lastError: z.string().nullable(), queued: z.number(),
  groups: z.array(z.object({ id: z.string(), title: z.string() })),
  conversations: z.array(z.object({ key: z.string(), title: z.string(), agentId: z.string(), workspaceId: z.string().optional(), current: z.boolean(), active: z.boolean() })),
});
export const listRpc = defineRpc({ name: "telegram.list", input: empty, output: z.object({ connections: z.array(connectionViewSchema), daemonConnected: z.boolean(), error: z.string().nullable() }) });
export const addRpc = defineRpc({ name: "telegram.add", input: z.object({ name: z.string().trim().min(1).max(80), token: z.string().trim().regex(/^\d{5,16}:[A-Za-z0-9_-]{20,160}$/) }).strict(), output: z.object({ id: z.uuid(), username: z.string() }) });
export const saveRpc = defineRpc({ name: "telegram.save", input: z.object({ id: z.uuid(), revision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), enabled: z.boolean(), target: targetSchema.nullable(), policy: policySchema, bindings: z.record(z.string().regex(/^-?\d+:\d+$/), targetSchema) }).strict(), output: connectionSchema });
export const pairRpc = defineRpc({ name: "telegram.pair", input: connectionId, output: z.object({ url: z.string(), expiresAt: z.number() }) });
export const disconnectRpc = defineRpc({ name: "telegram.disconnect", input: connectionId, output: z.object({ removed: z.boolean() }) });
export const revokeRpc = defineRpc({ name: "telegram.revoke", input: z.object({ id: z.uuid(), chatId: z.string().regex(/^-\d+$/) }).strict(), output: z.object({ revoked: z.boolean() }) });
export const modelSchema = z.object({ id: z.string(), label: z.string(), thinking: z.array(z.object({ id: z.string(), label: z.string() })) });
export const choicesSchema = z.object({
  agents: z.array(z.object({ id: z.string(), title: z.string(), workspaceId: z.string().nullable() })),
  workspaces: z.array(z.object({ id: z.string(), title: z.string(), directory: z.string(), project: z.string() })),
  providers: z.array(z.object({ id: z.string(), label: z.string(), models: z.array(modelSchema), modes: z.array(z.object({ id: z.string(), label: z.string() })) })),
  bots: z.array(z.object({ id: z.string(), name: z.string() })), botsAvailable: z.boolean(), botsError: z.string().nullable(),
});
export const choicesRpc = defineRpc({ name: "telegram.choices", input: empty, output: choicesSchema });
export type ConnectionView = z.output<typeof connectionViewSchema>;
export type Choices = z.output<typeof choicesSchema>;
