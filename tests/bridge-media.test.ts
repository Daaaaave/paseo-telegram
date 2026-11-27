import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { connectionSchema } from "../shared/config.ts";
import type { TelegramUpdate } from "../shared/telegram.ts";
import { Bridge } from "../server/bridge.ts";
import { MediaInput, type Downloader } from "../server/media.ts";
import { AgentQueue, type Router } from "../server/routing.ts";
import { Store } from "../server/store.ts";
import { Telegram, TelegramNetworkError } from "../server/telegram.ts";

interface Sent {
  method: string;
  payload: Record<string, unknown>;
}

class FakeTelegram extends Telegram {
  sent: Sent[] = [];
  downloads: string[] = [];
  failures: Record<string, (TelegramNetworkError | undefined)[]> = {};
  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const failure = this.failures[method]?.shift();
    if (failure) throw failure;
    this.sent.push({ method, payload });
    return { message_id: 500 + this.sent.length } as T;
  }
  async downloadFile(fileId: string, destination: string): Promise<number> {
    this.downloads.push(fileId);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "audio");
    return 5;
  }
  texts(method: string): string[] {
    return this.sent
      .filter((entry) => entry.method === method)
      .map((entry) => String(entry.payload.text));
  }
}

const connection = connectionSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test",
  enabled: true,
  botId: 900,
  username: "test_bot",
  target: { kind: "agent", agentId: "agent-1", sharedHistory: false },
  policy: {},
  bindings: {},
  revision: 0,
});

async function setup(reply = "Done.") {
  const root = await mkdtemp(join(tmpdir(), "tg-bridge-"));
  const store = new Store(root);
  store.state.ownerId = 1;
  store.state.ownerChatId = 1;
  const sentToAgent: string[] = [];
  const agent = {
    id: "agent-1",
    refresh: async () => ({ agent: { status: "idle", pendingPermissions: [] } }),
    timeline: {
      refetch: async () => ({ epoch: "e", entries: [], hasOlder: false }),
      subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
    },
    send: async (text: string) => {
      sentToAgent.push(text);
    },
    waitForFinish: async () => ({ status: "idle", lastMessage: reply, final: {} }),
  };
  const router = {
    api: { agents: { ref: () => agent } },
    target: () => connection.target,
    prepare: async () => ({ id: "agent-1", context: "" }),
    queueKey: () => "agent-1",
  } as unknown as Router;
  const telegram = new FakeTelegram();
  const downloader: Downloader = telegram;
  const bridge = new Bridge(
    telegram,
    store,
    router,
    () => connection,
    new AgentQueue(),
    new MediaInput(root, downloader, {
      transcribe: async () => "  envoie le rapport demain ",
    }),
    async () => {},
  );
  return { bridge, telegram, sentToAgent, store };
}

const voice = (userId: number): TelegramUpdate => ({
  update_id: 10,
  message: {
    message_id: 3,
    date: 1,
    chat: { id: userId, type: "private" },
    from: { id: userId },
    voice: { file_id: "voice-1", duration: 4 },
  },
});

test("owner voice note reaches the agent as a transcribed message and is echoed", async () => {
  const { bridge, telegram, sentToAgent } = await setup();
  await bridge.handle(voice(1));
  assert.equal(sentToAgent.length, 1);
  assert.match(sentToAgent[0], /\[Voice note, transcribed\] envoie le rapport demain/);
  assert.ok(telegram.texts("sendMessage").some((text) => text.startsWith("🎤 “envoie le rapport demain”")));
  assert.deepEqual(telegram.downloads, ["voice-1"]);
  assert.ok(telegram.texts("editMessageText").includes("Done."));
});

test("a stranger cannot trigger a download or transcription", async () => {
  const { bridge, telegram, sentToAgent, store } = await setup();
  await bridge.handle(voice(2));
  assert.deepEqual(telegram.downloads, []);
  assert.deepEqual(sentToAgent, []);
  assert.deepEqual(telegram.sent, []);
  assert.deepEqual(store.state.jobs, {});
});

test("an oversized document is refused without being sent to the agent", async () => {
  const { bridge, telegram, sentToAgent } = await setup();
  await bridge.handle({
    update_id: 11,
    message: {
      message_id: 4,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1 },
      document: { file_id: "big", file_name: "x.zip", file_size: 50_000_000 },
    },
  });
  assert.deepEqual(sentToAgent, []);
  assert.deepEqual(telegram.downloads, []);
  assert.ok(telegram.texts("editMessageText").some((text) => text.includes("larger than 20 MB")));
});

test("a pressed button is delivered as a normal message", async () => {
  const { bridge, telegram, sentToAgent } = await setup();
  await bridge.handle({
    update_id: 12,
    callback_query: {
      id: "cb1",
      from: { id: 1 },
      data: "reply:OK push",
      message: { message_id: 8, date: 1, chat: { id: 1, type: "private" } },
    },
  });
  assert.match(sentToAgent[0], /"text":"OK push"/);
  assert.ok(telegram.sent.some((entry) => entry.method === "answerCallbackQuery"));
  assert.ok(telegram.sent.some((entry) => entry.method === "editMessageReplyMarkup"));
  await bridge.handle({
    update_id: 13,
    callback_query: {
      id: "cb2",
      from: { id: 2 },
      data: "reply:OK push",
      message: { message_id: 8, date: 1, chat: { id: 1, type: "private" } },
    },
  });
  assert.equal(sentToAgent.length, 1);
});

test("agent buttons are attached to the final reply", async () => {
  const { bridge, telegram } = await setup("Push now?\n[buttons: OK push | Clore]");
  await bridge.handle({
    update_id: 14,
    message: { message_id: 5, date: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "status" },
  });
  const final = telegram.sent.filter((entry) => entry.method === "editMessageText").at(-1);
  assert.equal(final?.payload.text, "Push now?");
  assert.deepEqual(final?.payload.reply_markup, {
    inline_keyboard: [
      [
        { text: "OK push", callback_data: "reply:OK push" },
        { text: "Clore", callback_data: "reply:Clore" },
      ],
    ],
  });
});

test("a timed-out final edit is retried and delivered once", async () => {
  const { bridge, telegram, store } = await setup("All good.");
  telegram.failures.editMessageText = [new TelegramNetworkError("uncertain"), new TelegramNetworkError("uncertain")];
  await bridge.handle({
    update_id: 15,
    message: { message_id: 6, date: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "hello" },
  });
  assert.equal(telegram.texts("editMessageText").filter((text) => text === "All good.").length, 1);
  assert.equal(store.state.jobs["15"].delivery, "done");
});

test("when delivery keeps failing the user gets one short notice and no duplicate", async () => {
  const { bridge, telegram, store } = await setup("Long answer.");
  telegram.failures.editMessageText = Array.from({ length: 10 }, () => new TelegramNetworkError("uncertain"));
  await bridge.handle({
    update_id: 16,
    message: { message_id: 7, date: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "hello" },
  });
  assert.equal(store.state.jobs["16"].delivery, "uncertain");
  assert.equal(telegram.texts("editMessageText").length, 0);
  const notices = telegram.texts("sendMessage").filter((text) => text.startsWith("⚠️"));
  assert.equal(notices.length, 1);
  assert.ok(!notices[0].includes("Long answer"));
});
