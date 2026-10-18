export class TelegramError extends Error {
  readonly code: number;
  readonly retryAfter?: number;
  readonly reason?: "not_modified" | "uneditable";
  constructor(
    code: number,
    retryAfter?: number,
    reason?: "not_modified" | "uneditable",
  ) {
    super(`Telegram API error ${code}`);
    this.code = code;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Telegram request canceled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Chat-wide pacing includes every topic, initial status, edit and final chunk. */
export class TelegramOutbox {
  private readonly queues = new Map<number, Promise<void>>();
  private readonly next = new Map<number, number>();
  private readonly now: () => number;
  private readonly wait: typeof pause;
  constructor(now = Date.now, wait = pause) {
    this.now = now;
    this.wait = wait;
  }
  run<T>(
    chatId: number,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const pending = previous.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await this.wait(
          Math.max(0, (this.next.get(chatId) ?? 0) - this.now()),
          signal,
        );
        try {
          return await operation();
        } catch (error) {
          if (!(error instanceof TelegramError) || error.code !== 429)
            throw error;
          this.next.set(
            chatId,
            this.now() + Math.max(1, error.retryAfter ?? 5) * 1000,
          );
          if (attempt >= 2) throw error;
        } finally {
          this.next.set(
            chatId,
            Math.max(
              this.next.get(chatId) ?? 0,
              this.now() + (chatId < 0 ? 3100 : 1100),
            ),
          );
        }
      }
    });
    const settled = pending.then(
      () => {},
      () => {},
    );
    this.queues.set(chatId, settled);
    void settled.then(() => {
      if (this.queues.get(chatId) === settled) this.queues.delete(chatId);
    });
    return pending;
  }
}

export class Telegram {
  private readonly readToken: () => Promise<string>;
  constructor(
    readToken: () => Promise<string> = async () => {
      throw new Error("Telegram token is not configured");
    },
  ) {
    this.readToken = readToken;
  }
  private readonly outbox = new TelegramOutbox();
  async call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (
      (method === "sendMessage" || method === "editMessageText") &&
      typeof payload.chat_id === "number"
    ) {
      return this.outbox.run(
        payload.chat_id,
        () => this.request<T>(method, payload, signal),
        signal,
      );
    }
    return this.request<T>(method, payload, signal);
  }
  private async request<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = (await this.readToken()).trim();
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
      throw new Error("Invalid Telegram token configuration");
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
          : AbortSignal.timeout(35_000),
      });
    } catch {
      throw new Error("Telegram connection unavailable");
    }
    const body = (await response.json()) as {
      ok: boolean;
      result: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!response.ok || !body.ok) {
      const reason = /message is not modified/i.test(body.description ?? "")
        ? "not_modified"
        : /message to edit not found|message can't be edited/i.test(
              body.description ?? "",
            )
          ? "uneditable"
          : undefined;
      throw new TelegramError(
        body.error_code ?? response.status,
        body.parameters?.retry_after,
        reason,
      );
    }
    return body.result;
  }
}
