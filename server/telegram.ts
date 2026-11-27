import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export class FileTooLargeError extends Error {
  constructor() {
    super("File exceeds the size limit");
  }
}

export class TelegramError extends Error {
  readonly code: number;
  readonly retryAfter?: number;
  readonly reason?: "not_modified" | "uneditable" | "too_big";
  constructor(
    code: number,
    retryAfter?: number,
    reason?: "not_modified" | "uneditable" | "too_big",
  ) {
    super(`Telegram API error ${code}`);
    this.code = code;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

/** A request that produced no Telegram response. `unreachable` means the
 * connection was never made, so nothing was sent; `uncertain` means the request
 * may have been processed (timeout, reset), so a resend could duplicate it. */
export class TelegramNetworkError extends Error {
  readonly delivery: "unreachable" | "uncertain";
  constructor(delivery: "unreachable" | "uncertain") {
    super("Telegram connection unavailable");
    this.delivery = delivery;
  }
}
const UNREACHABLE = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function networkError(error: unknown): TelegramNetworkError {
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause
    ?.code;
  return new TelegramNetworkError(
    typeof code === "string" && UNREACHABLE.has(code)
      ? "unreachable"
      : "uncertain",
  );
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
  private readonly fetcher: typeof fetch;
  constructor(
    readToken: () => Promise<string> = async () => {
      throw new Error("Telegram token is not configured");
    },
    fetcher: typeof fetch = fetch,
  ) {
    this.readToken = readToken;
    this.fetcher = fetcher;
  }
  private async token(): Promise<string> {
    const token = (await this.readToken()).trim();
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
      throw new Error("Invalid Telegram token configuration");
    return token;
  }
  /** Downloads a file received by the bot into `destination`, stopping as soon
   * as it exceeds `maxBytes`. The token is only ever part of the request URL;
   * no error produced here includes it. Returns the stored size in bytes. */
  async downloadFile(
    fileId: string,
    destination: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const info = await this.call<{ file_path?: string; file_size?: number }>(
      "getFile",
      { file_id: fileId },
      signal,
    );
    const path = info.file_path;
    if (
      !path ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === "")
    )
      throw new Error("Telegram returned an invalid file path");
    if ((info.file_size ?? 0) > maxBytes) throw new FileTooLargeError();
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/file/bot${token}/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        {
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(120_000),
          ]),
        },
      );
    } catch {
      throw new Error("Telegram file download unavailable");
    }
    if (!response.ok || !response.body)
      throw new Error("Telegram file download failed");
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        done(size > maxBytes ? new FileTooLargeError() : null, chunk);
      },
    });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        limit,
        createWriteStream(destination, { mode: 0o600, flags: "wx" }),
      );
    } catch (error) {
      await rm(destination, { force: true });
      throw error instanceof FileTooLargeError
        ? error
        : new Error("Telegram file download failed");
    }
    return size;
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
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
          : AbortSignal.timeout(35_000),
      });
    } catch (error) {
      throw networkError(error);
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
        : /file is too big/i.test(body.description ?? "")
          ? "too_big"
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
