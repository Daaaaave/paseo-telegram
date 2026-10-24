import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskMessages } from "../server/messages.ts";
import { Store, type Job } from "../server/store.ts";
import { Telegram, TelegramError } from "../server/telegram.ts";
import { formatReply } from "../server/format.ts";
import type { TelegramMessage } from "../shared/telegram.ts";

class Recorder extends Telegram {
  calls: { method: string; payload: Record<string, unknown> }[] = [];
  nextId = 100;
  handler?: (method: string, payload: Record<string, unknown>) => Promise<void>;
  override async call<T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ method, payload });
    await this.handler?.(method, payload);
    return (
      method === "deleteMessages" ? true : { message_id: this.nextId++ }
    ) as T;
  }
}
const message: TelegramMessage = {
  message_id: 9,
  date: 100,
  chat: { id: -100, type: "supergroup" },
  message_thread_id: 8,
  from: { id: 10 },
  text: "Check",
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "paseo-messages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    telegram = new Recorder(),
    controller = new AbortController();
  let now = 1000;
  const messages = new TaskMessages(
    telegram,
    store,
    controller.signal,
    () => now,
  );
  const job: Job = {
    message,
    destination: { chatId: -100, topicId: 8 },
    answer: "**The answer**",
    delivery: "sending",
  };
  store.state.jobs[1] = job;
  const deleted = () =>
    telegram.calls
      .filter((c) => c.method === "deleteMessages")
      .flatMap((c) => c.payload.message_ids as number[]);
  const final = () =>
    messages.final(job, message, async () =>
      assert.fail("New finals must be new messages"),
    );
  return {
    root,
    store,
    telegram,
    messages,
    job,
    deleted,
    final,
    controller,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("a formatted final is a new reply at the bottom, then only its confirmed temporary messages disappear", async (t) => {
  const f = await fixture(t);
  await f.messages.track(f.job, 30);
  await f.messages.track(f.job, 31);
  f.telegram.handler = async (method) => {
    if (method !== "sendMessage") return;
    const saved = JSON.parse(
      await readFile(join(f.root, "state.json"), "utf8"),
    );
    assert.equal(
      saved.jobs[1].finalReply.sending,
      true,
      "send boundary is durable before Telegram receives it",
    );
    assert.deepEqual(f.deleted(), []);
  };
  assert.equal(await f.final(), 100);
  const sent = f.telegram.calls[0];
  assert.equal(sent.method, "sendMessage");
  assert.equal(sent.payload.message_thread_id, 8);
  assert.equal(sent.payload.text, "The answer");
  assert.equal((sent.payload.entities as any[])[0].type, "bold");
  assert.deepEqual(sent.payload.reply_parameters, {
    message_id: 9,
    allow_sending_without_reply: true,
  });
  assert.deepEqual(
    f.deleted(),
    [],
    "successful send alone is not the committed delivery receipt",
  );
  f.job.delivery = "done";
  await f.store.save();
  await f.messages.cleanup(f.job);
  assert.deepEqual(f.deleted(), [30, 31]);
  assert.deepEqual(f.job.finalReply?.messageIds, [100]);
  assert.deepEqual(f.job.temporaryMessageIds, []);
});

test("every final chunk must be confirmed before cleanup; an uncertain chunk is never resent", async (t) => {
  const f = await fixture(t);
  f.job.answer = "Long answer. ".repeat(800);
  const chunks = formatReply(f.job.answer);
  assert.ok(chunks.length > 2);
  await f.messages.track(f.job, 30);
  let sends = 0;
  f.telegram.handler = async (method) => {
    if (method === "sendMessage" && ++sends === 2)
      throw Error("Unknown outcome");
  };
  await assert.rejects(f.final(), /Unknown outcome/);
  assert.deepEqual(f.job.finalReply?.messageIds, [100]);
  assert.equal(f.job.finalReply?.sending, true);
  f.job.delivery = "uncertain";
  await f.store.save();
  await f.messages.cleanup(f.job);
  assert.deepEqual(f.deleted(), []);
  const restored = new Store(f.root);
  await restored.load();
  await assert.rejects(
    new TaskMessages(f.telegram, restored, f.controller.signal).final(
      restored.state.jobs[1],
      message,
      async () => 0,
    ),
    /unconfirmed send/,
  );
  assert.equal(
    sends,
    2,
    "reload cannot replay a chunk whose send outcome is unknown",
  );
});

test("a persisted chunk boundary resumes only the unsent remainder and protects every final chunk", async (t) => {
  const f = await fixture(t);
  f.job.answer = "**Long result**. ".repeat(600);
  const chunks = formatReply(f.job.answer);
  f.job.finalReply = {
    mode: "new",
    messageIds: [80],
    replyToMessageId: 9,
    sending: false,
  };
  await f.messages.track(f.job, 30);
  await f.final();
  assert.equal(
    f.telegram.calls.filter((c) => c.method === "sendMessage").length,
    chunks.length - 1,
  );
  assert.equal(f.telegram.calls[0].payload.text, chunks[1].text);
  f.job.delivery = "done";
  await f.store.save();
  await f.messages.cleanup(f.job);
  assert.deepEqual(f.deleted(), [30]);
  assert.ok(!f.deleted().includes(80));
});

test("cleanup protects requests, questions, final chunks and other conversations even when IDs overlap", async (t) => {
  const f = await fixture(t);
  await f.final();
  f.job.delivery = "done";
  f.store.state.jobs[2] = {
    destination: { chatId: -100, topicId: 9 },
    message: { ...message, message_id: 40 },
    finalReply: { mode: "new", messageIds: [41], replyToMessageId: 40 },
    question: { requestId: "q", fields: [], status: "answered", messageId: 42 },
  };
  f.store.state.jobs[3] = {
    destination: { chatId: -200, topicId: 8 },
    finalReply: { mode: "new", messageIds: [43], replyToMessageId: 44 },
  };
  f.job.temporaryMessageIds = [9, 30, 40, 41, 42, 43, 100];
  await f.messages.cleanup(f.job);
  assert.deepEqual(
    f.deleted(),
    [30, 43],
    "only recorded task-owned IDs in this chat are candidates; important messages are guarded",
  );
  assert.equal(f.telegram.calls.at(-1)?.payload.chat_id, -100);
});

test("older in-place finals survive an upgrade while their known approval cards are cleaned", async (t) => {
  const f = await fixture(t);
  f.job.finalReply = undefined;
  f.job.delivery = "done";
  f.job.progress = { startedAt: 0, attempted: true, messageId: 30 };
  f.job.temporaryMessageIds = [30, 31];
  await f.messages.cleanup(f.job);
  assert.deepEqual(f.deleted(), [31]);
  assert.equal(
    f.telegram.calls.some((c) => c.method === "sendMessage"),
    false,
  );
});

test("a late service confirmation is cleaned after final delivery, including while a sweep is in flight", async (t) => {
  const f = await fixture(t);
  await f.final();
  f.job.delivery = "done";
  f.job.temporaryMessageIds = [30];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.telegram.handler = async (method) => {
    if (method === "deleteMessages" && !f.deleted().includes(31)) {
      started();
      await gate;
    }
  };
  const cleanup = f.messages.cleanup(f.job);
  await ready;
  const late = f.messages.track(f.job, 31);
  release();
  await Promise.all([cleanup, late]);
  assert.deepEqual(f.deleted(), [30, 31]);
  await f.messages.notice(f.job, "Full access is enabled");
  assert.equal(
    f.telegram.calls.filter((c) => c.method === "sendMessage").length,
    1,
    "no redundant service post after a completed answer",
  );
});

test("cleanup retries are bounded and restart-safe without changing the delivered answer", async (t) => {
  const f = await fixture(t);
  await f.final();
  f.job.delivery = "done";
  f.job.temporaryMessageIds = [30];
  f.telegram.handler = async (method) => {
    if (method === "deleteMessages") throw Error("Unknown deletion outcome");
  };
  await f.messages.cleanup(f.job);
  assert.equal(f.job.delivery, "done");
  assert.equal(f.job.cleanup?.attempts, 1);
  await f.messages.cleanup(f.job);
  assert.equal(f.deleted().length, 1, "retry waits for cooldown");
  const restored = new Store(f.root);
  await restored.load();
  const messages = new TaskMessages(
    f.telegram,
    restored,
    f.controller.signal,
    () => 70_000,
  );
  f.telegram.handler = undefined;
  await messages.cleanup(restored.state.jobs[1]);
  assert.deepEqual(
    f.deleted(),
    [30, 30],
    "idempotent delete can recover an unknown deletion acknowledgement",
  );
  assert.deepEqual(restored.state.jobs[1].temporaryMessageIds, []);
  assert.equal(
    f.telegram.calls.filter((c) => c.method === "sendMessage").length,
    1,
  );
});

test("expired messages and lost deletion rights do not fail or resend the final answer", async (t) => {
  for (const code of [400, 403]) {
    const f = await fixture(t);
    await f.final();
    f.job.delivery = "done";
    f.job.temporaryMessageIds = [30];
    f.telegram.handler = async (method) => {
      if (method === "deleteMessages") throw new TelegramError(code);
    };
    await f.messages.cleanup(f.job);
    f.advance(10_000_000);
    await f.messages.cleanup(f.job);
    assert.equal(f.job.cleanup?.abandoned, true);
    assert.equal(f.deleted().length, 1);
    assert.equal(f.job.delivery, "done");
    assert.equal(f.job.failure, undefined);
    f.telegram.handler = undefined;
    await f.messages.track(f.job, 31);
    assert.deepEqual(
      f.deleted(),
      [30, 31],
      "a new late confirmation does not inherit an expired message's retry failure",
    );
  }
});

test("transient cleanup errors stop after five attempts; Telegram batches never exceed 100 IDs", async (t) => {
  const f = await fixture(t);
  await f.final();
  f.job.delivery = "done";
  f.job.temporaryMessageIds = Array.from({ length: 205 }, (_, i) => 1000 + i);
  await f.messages.cleanup(f.job);
  assert.deepEqual(
    f.telegram.calls
      .filter((c) => c.method === "deleteMessages")
      .map((c) => (c.payload.message_ids as number[]).length),
    [100, 100, 5],
  );
  f.job.temporaryMessageIds = [30];
  f.telegram.handler = async (method) => {
    if (method === "deleteMessages") throw new TelegramError(500);
  };
  for (let i = 0; i < 7; i++) {
    await f.messages.cleanup(f.job);
    f.advance(120_000);
  }
  assert.equal(f.job.cleanup?.attempts, 5);
  assert.equal(f.job.cleanup?.abandoned, true);
});

test("failed, canceled and uncertain tasks retain their temporary diagnostic messages", async (t) => {
  const f = await fixture(t);
  await f.final();
  f.job.temporaryMessageIds = [30];
  for (const delivery of [
    undefined,
    "sending",
    "uncertain",
    "canceled",
  ] as const) {
    f.job.delivery = delivery;
    await f.messages.cleanup(f.job);
  }
  f.job.delivery = "done";
  f.job.failure = "agent_error";
  await f.messages.cleanup(f.job);
  assert.deepEqual(f.deleted(), []);
});

test("full-access service confirmations are temporary and disappear only after the actual answer", async (t) => {
  const f = await fixture(t);
  f.job.delivery = undefined;
  await f.messages.notice(
    f.job,
    "Full access is enabled for this chat. Its history is preserved.",
  );
  assert.equal(f.telegram.calls[0].payload.message_thread_id, 8);
  assert.deepEqual(f.job.temporaryMessageIds, [100]);
  assert.deepEqual(f.deleted(), []);
  f.job.delivery = "sending";
  await f.final();
  f.job.delivery = "done";
  await f.store.save();
  await f.messages.cleanup(f.job);
  assert.deepEqual(f.deleted(), [100]);
  assert.deepEqual(f.job.finalReply?.messageIds, [101]);
});
