import { z } from "zod";

export const idSchema = z.string().min(1).max(256);
export const telegramIdSchema = z.number().int().safe();
export const profileSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("custom"), provider: z.string().regex(/^[^/]+\/.+$/).max(256), modeId: z.string().max(128).optional(), thinkingOptionId: z.string().max(128).optional(), systemPrompt: z.string().max(32_000).default("") }).strict(),
  z.object({ kind: z.literal("bots"), botId: idSchema }).strict(),
]);
export const gitSchema = z.object({ remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).default("origin"), branch: z.string().min(1).max(200).refine(value => !value.startsWith("-") && !/[\s~^:?*\[\\]|\.\.|@\{|\/\//.test(value), "Enter a branch name, such as main or development") }).strict();
export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: idSchema, sharedHistory: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("workspace"), workspaceId: idSchema, profile: profileSchema, git: gitSchema.nullable().default(null) }).strict(),
]);
export const policySchema = z.object({
  directMessages: z.enum(["owner", "operators", "everyone"]).default("owner"),
  groupUsers: z.enum(["operators", "everyone"]).default("operators"),
  operators: z.array(telegramIdSchema).max(100).default([]),
  invocation: z.enum(["mentions", "all"]).default("mentions"),
}).strict();
export const connectionSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(80), enabled: z.boolean(),
  botId: telegramIdSchema, username: z.string().regex(/^[A-Za-z0-9_]{5,64}$/),
  target: targetSchema.nullable(), policy: policySchema,
  bindings: z.record(z.string().regex(/^-?\d+:\d+$/), targetSchema).default({}),
  revision: z.number().int().nonnegative(),
}).strict();
export type Connection = z.output<typeof connectionSchema>;
export type Target = z.output<typeof targetSchema>;
export type Profile = z.output<typeof profileSchema>;
export type GitSettings = z.output<typeof gitSchema>;
export const BOT_LABEL = "paseo-bots.bot";
export const CONNECTION_LABEL = "telegram.connection";
export const CONVERSATION_LABEL = "telegram.conversation";
