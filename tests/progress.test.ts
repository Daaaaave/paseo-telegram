import test from "node:test";
import assert from "node:assert/strict";
import {
  ProgressMessage,
  publicProgress,
  canResumeFinalEdit,
} from "../server/progress.ts";
import { Telegram, TelegramError, TelegramOutbox } from "../server/telegram.ts";
import type { Job } from "../server/store.ts";
import type { TelegramMessage } from "../shared/telegram.ts";
import { formatReply } from "../server/format.ts";

class Recorder extends Telegram {
  calls: { method: string; payload: Record<string, unknown> }[] = [];
  handler?: (
    method: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  override async call<T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ method, payload });
    if (this.handler) return (await this.handler(method, payload)) as T;
    return { message_id: 77 } as T;
  }
}
const message: TelegramMessage = {
  message_id: 4,
  message_thread_id: 8,
  date: 100,
  chat: { id: -123, type: "supergroup" },
  from: { id: 10 },
  text: "Проверь проблему",
};
function fixture(job: Job = {}) {
  const telegram = new Recorder();
  let now = 1000;
  const saved: Job[] = [];
  const progress = new ProgressMessage({
    telegram,
    message,
    job,
    save: async () => {
      saved.push(structuredClone(job));
    },
    signal: new AbortController().signal,
    now: () => now,
    intervalMs: 3_600_000,
  });
  return {
    progress,
    telegram,
    job,
    saved,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("one status message follows the right topic, shows real public activity, and becomes the final answer", async () => {
  const { progress, telegram, job, saved, advance } = fixture();
  try {
    await Promise.all([progress.ensure(), progress.ensure()]);
    assert.equal(telegram.calls.length, 1);
    assert.equal(saved[0].progress?.attempted, true);
    assert.equal(saved[0].progress?.messageId, undefined);
    assert.equal(job.progress?.messageId, 77);
    assert.equal(telegram.calls[0].payload.message_thread_id, 8);
    assert.deepEqual(telegram.calls[0].payload.reply_parameters, {
      message_id: 4,
      allow_sending_without_reply: true,
    });
    progress.start();
    progress.observe({
      type: "timeline",
      provider: "codex",
      item: {
        type: "tool_call",
        name: "exec",
        callId: "a",
        status: "running",
        error: null,
        detail: {
          type: "shell",
          command: "npm test TOKEN_CANARY",
          output: "PRIVATE_TOOL_OUTPUT",
        },
      },
    });
    progress.observe({
      type: "timeline",
      provider: "codex",
      item: {
        type: "assistant_message",
        messageId: "public",
        text: "Проверяю ",
      },
    });
    progress.observe({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", messageId: "public", text: "ошибку." },
    });
    progress.observe({
      type: "timeline",
      provider: "codex",
      item: { type: "reasoning", text: "PRIVATE_REASONING" },
    });
    advance(15_000);
    await progress.refresh();
    const text = String(telegram.calls.at(-1)!.payload.text);
    assert.match(text, /15s/);
    assert.match(text, /Running checks/);
    assert.match(text, /Проверяю ошибку\./);
    assert.match(text, /Working/);
    assert.doesNotMatch(text, /PRIVATE_|TOKEN_CANARY/);
    advance(8000);
    await progress.refresh();
    assert.notEqual(telegram.calls.at(-1)!.payload.text, text);
    await progress.finish("Готово: проверка завершена.");
    assert.equal(
      telegram.calls.filter((call) => call.method === "sendMessage").length,
      1,
    );
    assert.equal(telegram.calls.at(-1)!.payload.message_id, 77);
    assert.equal(
      telegram.calls.at(-1)!.payload.text,
      "Готово: проверка завершена.",
    );
    const count = telegram.calls.length;
    await progress.refresh();
    assert.equal(telegram.calls.length, count);
  } finally {
    progress.dispose();
  }
});

test("reload reuses the saved message and elapsed time without sending another placeholder", async () => {
  const { progress, telegram, advance } = fixture({
    progress: { startedAt: 1000, attempted: true, messageId: 91 },
  });
  try {
    advance(65_000);
    await progress.ensure();
    assert.equal(telegram.calls.length, 0);
    progress.start();
    await progress.refresh();
    assert.equal(telegram.calls[0].payload.message_id, 91);
    assert.match(String(telegram.calls[0].payload.text), /1:05/);
    await progress.finish("Recovered result");
    assert.equal(
      telegram.calls.filter((call) => call.method === "sendMessage").length,
      0,
    );
  } finally {
    progress.dispose();
  }
});

test("live observation awaits readiness, switches subscription on account continuation, and releases it", async () => {
  const { progress, telegram } = fixture();
  type Agent = Parameters<ProgressMessage["watch"]>[0];
  type Handler = Parameters<Agent["timeline"]["subscribe"]>[0];
  const handlers = new Map<string, Handler>();
  const released: string[] = [];
  let ready!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const agent = (id: string) =>
    ({
      id,
      timeline: {
        subscribe: (handler: Handler) => {
          handlers.set(id, handler);
          return Object.assign(
            () => {
              released.push(id);
            },
            { ready: id === "first" ? firstReady : Promise.resolve() },
          );
        },
      },
    }) as unknown as Agent;
  try {
    await progress.ensure();
    progress.start();
    let watching = false;
    const first = progress.watch(agent("first")).then(() => {
      watching = true;
    });
    await Promise.resolve();
    assert.equal(watching, false);
    ready();
    await first;
    handlers.get("first")!({
      agentId: "first",
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "Before continuation" },
      },
    } as Parameters<Handler>[0]);
    await progress.watch(agent("second"));
    assert.deepEqual(released, ["first"]);
    assert.doesNotMatch(progress.render(), /Before continuation/);
    handlers.get("second")!({
      agentId: "second",
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "Continued update" },
      },
    } as Parameters<Handler>[0]);
    await progress.refresh();
    assert.match(
      String(telegram.calls.at(-1)!.payload.text),
      /Continued update/,
    );
    await progress.finish("Done");
    assert.deepEqual(released, ["first", "second"]);
  } finally {
    ready();
    progress.dispose();
  }
});

test("final output waits for an in-flight progress edit so stale activity cannot overwrite it", async () => {
  const { progress, telegram } = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await progress.ensure();
    let firstEdit = true;
    telegram.handler = async () => {
      if (firstEdit) {
        firstEdit = false;
        await pending;
      }
      return true;
    };
    progress.start();
    const edit = progress.refresh();
    const final = progress.finish("Final answer");
    await Promise.resolve();
    assert.equal(
      telegram.calls.filter((call) => call.method === "editMessageText").length,
      1,
    );
    release();
    await Promise.all([edit, final]);
    assert.equal(telegram.calls.at(-1)!.payload.text, "Final answer");
  } finally {
    release();
    progress.dispose();
  }
});

test("a missing placeholder falls back to the answer, and a deleted placeholder gets one replacement", async () => {
  const first = fixture();
  try {
    first.telegram.handler = async () => {
      throw new Error("Connection unavailable");
    };
    await first.progress.ensure();
    first.telegram.handler = undefined;
    await first.progress.finish("Answer despite missing status");
    assert.equal(
      first.telegram.calls.at(-1)!.payload.text,
      "Answer despite missing status",
    );
  } finally {
    first.progress.dispose();
  }
  const second = fixture();
  try {
    await second.progress.ensure();
    second.telegram.handler = async (method) => {
      if (method === "editMessageText")
        throw new TelegramError(400, undefined, "uneditable");
      return { message_id: 92 };
    };
    await second.progress.finish("Replacement answer");
    assert.equal(second.job.progress?.replacementAttempted, true);
    assert.equal(second.telegram.calls.at(-1)!.method, "sendMessage");
    assert.equal(
      second.telegram.calls.at(-1)!.payload.text,
      "Replacement answer",
    );
  } finally {
    second.progress.dispose();
  }
});

test("unchanged final edits succeed; permission failures do not create duplicate replies", async () => {
  const { progress, telegram } = fixture();
  try {
    await progress.ensure();
    telegram.handler = async () => {
      throw new TelegramError(400, undefined, "not_modified");
    };
    await progress.finish("Already delivered");
    telegram.handler = async () => {
      throw new TelegramError(403);
    };
    await assert.rejects(progress.finish("Denied"), /403/);
    assert.equal(
      telegram.calls.filter((call) => call.method === "sendMessage").length,
      1,
    );
  } finally {
    progress.dispose();
  }
});

test("only a single idempotent final edit is eligible for replay after a delivery crash", () => {
  const job: Job = {
    answer: "Done",
    delivery: "sending",
    progress: { startedAt: 0, attempted: true, messageId: 91 },
  };
  assert.equal(canResumeFinalEdit(job), true);
  assert.equal(canResumeFinalEdit({ ...job, answer: "x".repeat(4000) }), false);
  assert.equal(
    canResumeFinalEdit({
      ...job,
      progress: { ...job.progress!, replacementAttempted: true },
    }),
    false,
  );
  assert.equal(canResumeFinalEdit({ ...job, progress: undefined }), false);
  const table = `| ${"Header".repeat(80)} |\n|---|\n${"| x |\n".repeat(12)}`;
  assert.ok(table.length < 3800 && formatReply(table).length > 1);
  assert.equal(
    canResumeFinalEdit({ ...job, answer: table }),
    false,
    "table expansion can require multiple Telegram messages",
  );
});

test("status edits and final replacement preserve Telegram formatting entities", async () => {
  const { progress, telegram } = fixture();
  try {
    await progress.ensure();
    progress.start();
    progress.observe({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "Проверяю **формат** и `код`." },
    });
    await progress.refresh();
    assert.doesNotMatch(String(telegram.calls.at(-1)!.payload.text), /\*\*|`/);
    assert.deepEqual(
      (telegram.calls.at(-1)!.payload.entities as { type: string }[]).map(
        (entity) => entity.type,
      ),
      ["bold", "code"],
    );
    progress.observe({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "Bearer&#32;CREDENTIAL_CANARY" },
    });
    await progress.refresh();
    assert.doesNotMatch(
      String(telegram.calls.at(-1)!.payload.text),
      /CREDENTIAL_CANARY/,
    );
    const answer = formatReply("**Готово**, поле `prompt`.")[0];
    telegram.handler = async (method) => {
      if (method === "editMessageText")
        throw new TelegramError(400, undefined, "uneditable");
      return { message_id: 92 };
    };
    await progress.finish(answer.text, answer.entities);
    assert.equal(telegram.calls.at(-1)!.method, "sendMessage");
    assert.deepEqual(telegram.calls.at(-1)!.payload.entities, answer.entities);
  } finally {
    progress.dispose();
  }
});

test("public progress suppresses credential-like text and strips presentation/control noise", () => {
  for (const text of [
    "token = PRIVATE",
    "Bearer fake",
    "sk-placeholder",
    "123456:fake-token",
    "https://user:password@example.test/",
  ])
    assert.equal(publicProgress(text), "");
  assert.equal(publicProgress("---\nПроверяю\u0000 код"), "Проверяю код");
  assert.ok(publicProgress("🙂".repeat(900)).length <= 1400);
});

test("chat-wide write pacing serializes topics and honors Telegram retry_after", async () => {
  let now = 0;
  const times: number[] = [];
  const outbox = new TelegramOutbox(
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  const operation = async () => {
    times.push(now);
    return true;
  };
  await Promise.all([
    outbox.run(-123, operation),
    outbox.run(-123, operation),
    outbox.run(-123, operation),
  ]);
  assert.ok(times[1] - times[0] >= 3100);
  assert.ok(times[2] - times[1] >= 3100);
  let attempts = 0;
  const retries: number[] = [];
  await outbox.run(-123, async () => {
    retries.push(now);
    if (++attempts < 3) throw new TelegramError(429, 7);
    return true;
  });
  assert.equal(attempts, 3);
  assert.ok(retries[1] - retries[0] >= 7000);
  assert.ok(retries[2] - retries[1] >= 7000);
  let failures = 0;
  await assert.rejects(
    outbox.run(-123, async () => {
      failures++;
      throw new Error("Unknown delivery outcome");
    }),
  );
  assert.equal(failures, 1);
  await outbox.run(-123, operation);
});
