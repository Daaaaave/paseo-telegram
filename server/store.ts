import { join } from "node:path";
import { z } from "zod";
import type { TelegramMessage } from "../shared/telegram.ts";
import { targetSchema } from "../shared/config.ts";
import type { SyncReport } from "./sync.ts";
import { atomicWrite, readJson } from "./files.ts";

const questionSchema = z.object({
  requestId: z.string(),
  fields: z.array(
    z.object({
      header: z.string(),
      text: z.string(),
      options: z.array(z.string()),
    }),
  ),
  status: z.enum(["pending", "responding", "answered"]),
  messageId: z.number().optional(),
  notificationAttempted: z.boolean().optional(),
});
export type Question = z.output<typeof questionSchema>;
export interface Job {
  message?: TelegramMessage;
  agentId?: string;
  answer?: string;
  route?: z.output<typeof targetSchema>;
  routeKey?: string;
  dispatch?: "sending" | "sent";
  after?: { epoch: string; seq: number };
  destination?: { chatId: number; topicId: number };
  question?: Question;
  questionReply?: {
    sourceJobId: string;
    answers: Record<string, string>;
    attempted?: boolean;
    followUpAfter?: { epoch: string; seq: number };
  };
  sync?: SyncReport;
  failure?: "agent_request_failed" | "agent_error" | "missing_final_answer";
  progress?: {
    startedAt: number;
    attempted: boolean;
    messageId?: number;
    replacementAttempted?: boolean;
  };
  delivery?: "sending" | "done" | "uncertain" | "canceled";
}
const jobSchema: z.ZodType<Job> = z.object({
  message: z
    .custom<TelegramMessage>(
      (value) =>
        !!value &&
        typeof value === "object" &&
        Number.isSafeInteger((value as TelegramMessage).message_id) &&
        !!(value as TelegramMessage).chat &&
        Number.isSafeInteger((value as TelegramMessage).chat.id),
    )
    .optional(),
  agentId: z.string().optional(),
  answer: z.string().optional(),
  route: targetSchema.optional(),
  routeKey: z.string().optional(),
  dispatch: z.enum(["sending", "sent"]).optional(),
  after: z.object({ epoch: z.string(), seq: z.number() }).optional(),
  destination: z
    .object({
      chatId: z.number().int().safe(),
      topicId: z.number().int().nonnegative(),
    })
    .optional(),
  question: questionSchema.optional(),
  questionReply: z
    .object({
      sourceJobId: z.string(),
      answers: z.record(z.string(), z.string()),
      attempted: z.boolean().optional(),
      followUpAfter: z
        .object({ epoch: z.string(), seq: z.number() })
        .optional(),
    })
    .optional(),
  sync: z
    .custom<SyncReport>(
      (value) =>
        !!value &&
        typeof value === "object" &&
        ["ready", "attention", "blocked"].includes((value as SyncReport).state),
    )
    .optional(),
  failure: z
    .enum(["agent_request_failed", "agent_error", "missing_final_answer"])
    .optional(),
  progress: z
    .object({
      startedAt: z.number(),
      attempted: z.boolean(),
      messageId: z.number().optional(),
      replacementAttempted: z.boolean().optional(),
    })
    .optional(),
  delivery: z.enum(["sending", "done", "uncertain", "canceled"]).optional(),
});
const groupSchema = z.object({
  title: z.string(),
  addedBy: z.number().int().safe(),
  addedAt: z.number(),
});
export const stateSchema = z.object({
  version: z.literal(1),
  offset: z.number().int().nonnegative(),
  ownerId: z.number().int().safe().nullable(),
  ownerChatId: z.number().int().safe().nullable(),
  pairing: z
    .object({ hash: z.string().length(64), expiresAt: z.number() })
    .nullable(),
  groups: z.record(z.string(), groupSchema),
  pendingGroups: z.record(z.string(), groupSchema),
  aliases: z.record(z.string(), z.string()).default({}),
  agents: z.record(z.string(), z.string()),
  conversations: z.record(
    z.string(),
    z.object({
      key: z.string(),
      title: z.string(),
      agentId: z.string(),
      workspaceId: z.string().optional(),
      routeKey: z.string(),
      folder: z.string().optional(),
      branch: z.string().optional(),
    }),
  ),
  jobs: z.record(z.string(), jobSchema),
});
export type State = z.output<typeof stateSchema>;
export const initialState = (): State => ({
  version: 1,
  offset: 0,
  ownerId: null,
  ownerChatId: null,
  pairing: null,
  groups: {},
  pendingGroups: {},
  aliases: {},
  agents: {},
  conversations: {},
  jobs: {},
});
export class Store {
  state = initialState();
  private saving: Promise<void> = Promise.resolve();
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async load(): Promise<void> {
    const raw = await readJson(join(this.root, "state.json"));
    if (raw !== undefined) this.state = stateSchema.parse(raw);
  }
  save(): Promise<void> {
    const value = structuredClone(this.state);
    const task = this.saving.then(() =>
      atomicWrite(join(this.root, "state.json"), value),
    );
    this.saving = task.catch(() => {});
    return task;
  }
}
