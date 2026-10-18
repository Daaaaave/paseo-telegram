import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { TelegramMessage } from "../shared/telegram.ts";
import type { Job } from "./store.ts";
import { Telegram, TelegramError } from "./telegram.ts";
import { formatReply, type TextEntity, type TelegramText } from "./format.ts";

type Agent = ReturnType<PluginHookContext["paseo"]["agents"]["ref"]>;
type Event = Parameters<
  Parameters<Agent["timeline"]["subscribe"]>[0]
>[0]["event"];
type Activity =
  | "queued"
  | "working"
  | "read"
  | "edit"
  | "search"
  | "test"
  | "command"
  | "context"
  | "permission"
  | "error";
const LABELS = {
  queued: "⏳ Request received",
  working: "Working on your request",
  read: "📄 Reading files",
  edit: "🛠 Making changes",
  search: "🔎 Looking up information",
  test: "🧪 Running checks",
  command: "🖥 Running a command",
  context: "🧩 Updating context",
  permission: "⏸ Waiting for permission",
  error: "⚠️ Checking an error",
};

/** Only public assistant updates are rendered; tool arguments/output never are. */
export function publicProgress(text: string): string {
  const clean = text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/^\s*(?:---\s*)+/g, "");
  if (
    /(?:token|password|secret|authorization|api[_ -]?key|токен|пароль)\s*[:=]|\b(?:sk-|glpat-|ghp_|github_pat_)|\b\d{6,}:[\w-]+|\bBearer\s|https?:\/\/[^\s/]+:[^\s/@]+@/i.test(
      clean,
    )
  )
    return "";
  return [...clean].slice(0, 700).join("").trim();
}

/** Repeating an edit is idempotent; repeating an uncertain new message is not. */
export function canResumeFinalEdit(job: Job): boolean {
  return (
    job.delivery === "sending" &&
    Boolean(job.progress?.messageId) &&
    !job.progress?.replacementAttempted &&
    Boolean(job.answer) &&
    formatReply(job.answer!).length === 1
  );
}

export class ProgressMessage {
  private readonly telegram: Telegram;
  private readonly message: TelegramMessage;
  private readonly job: Job;
  private readonly save: () => Promise<void>;
  private readonly signal: AbortSignal;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private activity: Activity = "queued";
  private commentary = "";
  private textId: string | undefined;
  private buffer = "";
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private watchedId?: string;
  private inFlight?: Promise<void>;
  private initialization?: Promise<void>;
  private active = false;
  private closed = false;
  private lastText = "";
  private frame = 0;

  constructor(options: {
    telegram: Telegram;
    message: TelegramMessage;
    job: Job;
    save: () => Promise<void>;
    signal: AbortSignal;
    now?: () => number;
    intervalMs?: number;
  }) {
    this.telegram = options.telegram;
    this.message = options.message;
    this.job = options.job;
    this.save = options.save;
    this.signal = options.signal;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 8000;
    this.job.progress ??= { startedAt: this.now(), attempted: false };
  }

  ensure(): Promise<void> {
    return (this.initialization ??= this.create().catch((error) => {
      this.initialization = undefined;
      throw error;
    }));
  }
  private async create(): Promise<void> {
    const state = this.job.progress!;
    if (state.messageId || state.attempted) return;
    state.attempted = true;
    await this.save();
    try {
      const content = this.statusContent(this.render());
      const result = await this.telegram.call<{ message_id: number }>(
        "sendMessage",
        this.reply(content.text, content.entities),
        this.signal,
      );
      if (Number.isSafeInteger(result.message_id) && result.message_id > 0) {
        state.messageId = result.message_id;
        await this.save();
      }
    } catch {
      /* A missing progress message must not prevent the task itself. */
    }
  }

  start(): void {
    if (this.active || this.closed) return;
    this.active = true;
    this.activity = "working";
    this.schedule();
  }
  private schedule(): void {
    if (!this.active || this.closed || this.signal.aborted) return;
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }
  async watch(agent: Agent): Promise<void> {
    if (this.watchedId === agent.id && this.unsubscribe) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.closed || !this.job.progress?.messageId) return;
    this.buffer = "";
    this.textId = undefined;
    this.commentary = "";
    try {
      const subscription = agent.timeline.subscribe(({ event }) =>
        this.observe(event),
      );
      this.unsubscribe = subscription;
      this.watchedId = agent.id;
      await subscription.ready;
    } catch {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }
  observe(event: Event): void {
    if (this.closed) return;
    if (event.type === "permission_requested") this.activity = "permission";
    if (event.type === "turn_failed") this.activity = "error";
    if (event.type !== "timeline") return;
    const item = event.item;
    if (item.type === "assistant_message") {
      const sameMessage = item.messageId && item.messageId === this.textId;
      this.buffer = (
        sameMessage && !item.text.startsWith(this.buffer)
          ? this.buffer + item.text
          : item.text
      ).slice(0, 2500);
      this.textId = item.messageId;
      this.commentary = publicProgress(this.buffer);
    } else if (item.type === "compaction") this.activity = "context";
    else if (item.type === "tool_call") {
      if (item.status !== "running") {
        this.activity = item.status === "failed" ? "error" : "working";
        return;
      }
      const detail = item.detail;
      this.activity =
        detail.type === "read"
          ? "read"
          : detail.type === "edit" || detail.type === "write"
            ? "edit"
            : detail.type === "search"
              ? "search"
              : detail.type === "shell"
                ? /\b(?:pytest|vitest|jest|test|typecheck|knowledge:check)\b/.test(
                    detail.command,
                  )
                  ? "test"
                  : "command"
                : "working";
    }
  }
  render(): string {
    const seconds = Math.max(
      0,
      Math.floor((this.now() - this.job.progress!.startedAt) / 1000),
    );
    const elapsed =
      seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const title = this.active
      ? `${["🤔", "💭", "🧠"][this.frame++ % 3]} Working`
      : LABELS.queued;
    return `${title} · ${elapsed}${this.active ? `\n${LABELS[this.activity]}` : ""}${this.commentary ? `\n\n${this.commentary}` : ""}`;
  }
  private statusContent(text: string): TelegramText {
    const content = formatReply(text)[0];
    // Decoding Markdown escapes/entities must not bypass the public-update filter.
    return publicProgress(content.text)
      ? content
      : formatReply(text.split("\n\n", 1)[0])[0];
  }
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const id = this.job.progress?.messageId;
    if (this.closed || this.signal.aborted || !id) return Promise.resolve();
    const text = this.render();
    if (text === this.lastText) return Promise.resolve();
    const content = this.statusContent(text);
    this.inFlight = this.telegram
      .call(
        "editMessageText",
        {
          chat_id: this.message.chat.id,
          message_id: id,
          ...content,
          link_preview_options: { is_disabled: true },
        },
        this.signal,
      )
      .then(() => {
        this.lastText = text;
      })
      .catch(() => {})
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
  dispose(): void {
    this.closed = true;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  async stop(): Promise<void> {
    this.dispose();
    await this.inFlight;
  }
  async finish(
    firstChunk: string,
    entities: TextEntity[] = [],
  ): Promise<number | undefined> {
    await this.stop();
    const id = this.job.progress?.messageId;
    if (id) {
      try {
        await this.telegram.call(
          "editMessageText",
          {
            chat_id: this.message.chat.id,
            message_id: id,
            text: firstChunk,
            entities,
            link_preview_options: { is_disabled: true },
          },
          this.signal,
        );
        return id;
      } catch (error) {
        if (error instanceof TelegramError && error.reason === "not_modified")
          return id;
        if (!(error instanceof TelegramError) || error.reason !== "uneditable")
          throw error;
      }
      this.job.progress!.replacementAttempted = true;
      await this.save();
    }
    const sent = await this.telegram.call<{ message_id: number }>(
      "sendMessage",
      this.reply(firstChunk, entities),
      this.signal,
    );
    return sent.message_id;
  }
  private reply(
    text: string,
    entities: TextEntity[] = [],
  ): Record<string, unknown> {
    return {
      chat_id: this.message.chat.id,
      text,
      entities,
      ...(this.message.message_thread_id
        ? { message_thread_id: this.message.message_thread_id }
        : {}),
      reply_parameters: {
        message_id: this.message.message_id,
        allow_sending_without_reply: true,
      },
      link_preview_options: { is_disabled: true },
    };
  }
}
