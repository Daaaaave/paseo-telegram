import type { TelegramMessage } from "../shared/telegram.ts";
import type { Job, Store } from "./store.ts";
import { Telegram, TelegramError } from "./telegram.ts";
import { formatReply, type TelegramText } from "./format.ts";

/** Confirmed bot message IDs only. Never infer ownership from a chat ID range. */
export class TaskMessages {
  private readonly cleaning = new WeakMap<Job, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly telegram: Telegram;
  private readonly store: Store;
  private readonly signal: AbortSignal;
  private readonly now: () => number;
  constructor(
    telegram: Telegram,
    store: Store,
    signal: AbortSignal,
    now = Date.now,
  ) {
    this.telegram = telegram;
    this.store = store;
    this.signal = signal;
    this.now = now;
  }

  async track(job: Job, id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    if (!job.temporaryMessageIds?.includes(id)) {
      if (job.cleanup?.abandoned) {
        job.temporaryMessageIds = [];
        delete job.cleanup;
      }
      (job.temporaryMessageIds ??= []).push(id);
      await this.store.save();
    }
    await this.cleanup(job);
  }

  async notice(job: Job, text: string): Promise<void> {
    if (!job.destination || (job.delivery === "done" && !job.failure)) return;
    const sent = await this.telegram.call<{ message_id: number }>(
      "sendMessage",
      {
        chat_id: job.destination.chatId,
        text,
        ...(job.destination.topicId
          ? { message_thread_id: job.destination.topicId }
          : {}),
      },
      this.signal,
    );
    await this.track(job, sent.message_id);
  }

  /** Persist the send boundary before every chunk; uncertain sends never replay. */
  async final(
    job: Job,
    message: TelegramMessage,
    legacyEdit: (first: TelegramText) => Promise<number | undefined>,
  ): Promise<number> {
    const chunks = formatReply(job.answer!);
    job.finalReply ??= {
      mode: "new",
      messageIds: [],
      replyToMessageId: message.message_id,
    };
    const receipt = job.finalReply;
    if (receipt.sending)
      throw new Error("A final reply has an unconfirmed send");
    if (receipt.messageIds.length > chunks.length)
      throw new Error("The saved final reply changed");
    for (
      let index = receipt.messageIds.length;
      index < chunks.length;
      index++
    ) {
      receipt.sending = true;
      await this.store.save();
      const content = chunks[index];
      const id =
        receipt.mode === "legacy-edit" && index === 0
          ? await legacyEdit(content)
          : (
              await this.telegram.call<{ message_id: number }>(
                "sendMessage",
                {
                  chat_id: message.chat.id,
                  ...content,
                  ...(message.message_thread_id
                    ? { message_thread_id: message.message_thread_id }
                    : {}),
                  reply_parameters: {
                    message_id: receipt.replyToMessageId,
                    allow_sending_without_reply: true,
                  },
                  link_preview_options: { is_disabled: true },
                },
                this.signal,
              )
            ).message_id;
      if (!Number.isSafeInteger(id) || !id || id <= 0)
        throw new Error("The final reply message ID could not be confirmed");
      receipt.messageIds.push(id);
      receipt.sending = false;
      await this.store.save();
    }
    return receipt.messageIds.at(-1)!;
  }

  cleanup(job: Job): Promise<void> {
    const prior = this.cleaning.get(job) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(() => this.clean(job));
    this.cleaning.set(job, task);
    this.pending.add(task);
    void task
      .finally(() => {
        this.pending.delete(task);
        if (this.cleaning.get(job) === task) this.cleaning.delete(job);
      })
      .catch(() => {});
    return task;
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  private async clean(job: Job): Promise<void> {
    if (
      this.signal.aborted ||
      job.delivery !== "done" ||
      job.failure ||
      !job.destination ||
      !job.temporaryMessageIds?.length ||
      job.cleanup?.abandoned ||
      (job.cleanup?.retryAt ?? 0) > this.now()
    )
      return;
    const protectedIds = new Set<number>();
    for (const other of Object.values(this.store.state.jobs)) {
      if (other.destination?.chatId !== job.destination.chatId) continue;
      if (other.message) protectedIds.add(other.message.message_id);
      if (other.finalReply) {
        protectedIds.add(other.finalReply.replyToMessageId);
        if (!other.finalReply.service)
          for (const id of other.finalReply.messageIds) protectedIds.add(id);
      }
      if (other.question?.messageId) protectedIds.add(other.question.messageId);
      // Older versions edited the status into the final answer.
      if (
        (!other.finalReply || other.finalReply.mode === "legacy-edit") &&
        other.delivery &&
        other.progress?.messageId
      )
        protectedIds.add(other.progress.messageId);
    }
    const ids = [...new Set(job.temporaryMessageIds)].filter(
      (id) => !protectedIds.has(id),
    );
    if (!ids.length) {
      job.temporaryMessageIds = [];
      delete job.cleanup;
      await this.store.save();
      return;
    }
    for (let index = 0; index < ids.length; index += 100) {
      const batch = ids.slice(index, index + 100);
      try {
        const result = await this.telegram.call<boolean>(
          "deleteMessages",
          {
            chat_id: job.destination.chatId,
            message_ids: batch,
          },
          this.signal,
        );
        if (result !== true) throw new Error("Cleanup was not confirmed");
      } catch (error) {
        if (this.signal.aborted) return;
        const attempts = (job.cleanup?.attempts ?? 0) + 1;
        job.cleanup = {
          attempts,
          retryAt:
            this.now() +
            Math.max(
              60,
              error instanceof TelegramError ? (error.retryAfter ?? 0) : 0,
            ) *
              1000,
          abandoned:
            attempts >= 5 ||
            (error instanceof TelegramError &&
              [400, 401, 403].includes(error.code)),
        };
        await this.store.save();
        return;
      }
      const removed = new Set(batch);
      job.temporaryMessageIds = job.temporaryMessageIds!.filter(
        (id) => !removed.has(id) && !protectedIds.has(id),
      );
      delete job.cleanup;
      await this.store.save();
    }
  }
}
