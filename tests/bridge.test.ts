import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaseoApi } from "@getpaseo/client";
import {
  connectionSchema,
  type Connection,
  type Target,
} from "../shared/config.ts";
import type { TelegramMessage } from "../shared/telegram.ts";
import { Store } from "../server/store.ts";
import { Registry } from "../server/registry.ts";
import { Bridge, findDispatch, messageIdentity } from "../server/bridge.ts";
import { Router, AgentQueue, routeIdentity } from "../server/routing.ts";
import { BotsAdapter } from "../server/bots.ts";
import { Telegram } from "../server/telegram.ts";
import { formatReply } from "../server/format.ts";
import { authorized } from "../server/policy.ts";
import { localTarget } from "../server/daemon.ts";

const config = (
  target: Target | null = {
    kind: "workspace",
    workspaceId: "workspace",
    profile: {
      kind: "custom",
      provider: "example/model",
      systemPrompt: "Help the team",
    },
    git: null,
  },
): Connection =>
  connectionSchema.parse({
    id: randomUUID(),
    name: "Team",
    enabled: true,
    botId: 77,
    username: "demo_help_bot",
    target,
    policy: {},
    bindings: {},
    revision: 0,
  });
const message = (chatId = -100, topic = 0, user = 10): TelegramMessage => ({
  message_id: Math.abs(chatId) + topic,
  date: 100,
  chat: {
    id: chatId,
    type: chatId < 0 ? "supergroup" : "private",
    title: `Group ${chatId}`,
  },
  from: { id: user },
  text: "@demo_help_bot Please check",
  entities: [{ type: "mention", offset: 0, length: 14 }],
  ...(topic ? { message_thread_id: topic } : {}),
});
class Recorder extends Telegram {
  calls: { method: string; payload: Record<string, unknown> }[] = [];
  canReadAllGroupMessages = true;
  membership = { status: "member" };
  administrators: () => Promise<unknown> = async () => [];
  override async call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.calls.push({ method, payload });
    if (method === "getChatAdministrators")
      return (await this.administrators()) as T;
    if (method === "getMe")
      return {
        id: 77, username: "demo_help_bot",
        can_read_all_group_messages: this.canReadAllGroupMessages,
      } as T;
    if (method === "getChatMember") return this.membership as T;
    if (method === "getWebhookInfo") return { url: "" } as T;
    if (method === "deleteMessages") return true as T;
    if (method === "getUpdates")
      return await new Promise<T>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        }),
      );
    return { message_id: this.calls.length + 1000 } as T;
  }
}
function sdk() {
  const created: {
    config: unknown;
    labels?: Record<string, string>;
    agentId?: string;
  }[] = [];
  const sent: { id: string; text: string; messageId?: string }[] = [];
  const histories = new Map<
    string,
    { seqEnd: number; item: { type: string; messageId?: string } }[]
  >();
  const handles = new Map<string, ReturnType<PaseoApi["agents"]["ref"]>>();
  let wait: (() => Promise<unknown>) | undefined;
  const ref = (id: string) => {
    if (!handles.has(id)) {
      const handle = {
        id,
        refresh: async () => ({
          agent: {
            id,
            cwd: "/project",
            workspaceId: "workspace",
            status: "idle",
            activeTurn: null,
            archivedAt: null,
          },
        }),
        timeline: {
          refetch: async () => ({
            epoch: "epoch",
            entries: histories.get(id) ?? [],
            hasOlder: false,
          }),
          subscribe: () =>
            Object.assign(() => {}, { ready: Promise.resolve() }),
        },
        send: async (text: string, options: { messageId?: string }) => {
          sent.push({ id, text, messageId: options.messageId });
          const entries = histories.get(id) ?? [];
          entries.push({
            seqEnd: entries.length + 1,
            item: { type: "user_message", messageId: options.messageId },
          });
          histories.set(id, entries);
        },
        waitForFinish: async () =>
          wait
            ? wait()
            : {
                status: "idle",
                lastMessage: `Done by ${id}`,
                final: { status: "idle", activeTurn: null },
              },
      } as unknown as ReturnType<PaseoApi["agents"]["ref"]>;
      handles.set(id, handle);
    }
    return handles.get(id)!;
  };
  const api = {
    agents: { ref },
    workspaces: {
      ref: (id: string) => ({
        id,
        refresh: async () => ({
          id,
          projectId: "project",
          workspaceDirectory: "/project",
        }),
        agents: {
          create: async (options: {
            agentId: string;
            config: unknown;
            labels?: Record<string, string>;
          }) => {
            created.push(options);
            return ref(options.agentId);
          },
        },
      }),
      create: () =>
        assert.fail(
          "ordinary workspace routes must not create projects or worktrees",
        ),
    },
  } as unknown as PaseoApi;
  return {
    api,
    created,
    sent,
    histories,
    handles,
    setWait: (value: () => Promise<unknown>) => {
      wait = value;
    },
  };
}
async function fixture(
  connection = config(),
  sharedSdk = sdk(),
  queue = new AgentQueue(),
) {
  const root = await mkdtemp(join(tmpdir(), "paseo-telegram-test-")),
    store = new Store(root),
    telegram = new Recorder();
  store.state.ownerId = 10;
  store.state.ownerChatId = 10;
  for (const id of [-100, -200])
    store.state.groups[id] = {
      title: `Group ${id}`,
      addedBy: 10,
      addedAt: 100,
    };
  const bots = new BotsAdapter(
    async () => assert.fail("ordinary routes must work without Bots"),
    null,
  );
  const router = new Router(sharedSdk.api, bots, store, () => connection);
  const bridge = new Bridge(telegram, store, router, () => connection, queue);
  return { connection, store, telegram, router, bridge, root, ...sharedSdk };
}

test("one ordinary agent per Telegram group/topic; later messages reuse its history", async () => {
  const f = await fixture();
  await f.bridge.handle({ update_id: 1, message: message(-100) });
  await f.bridge.handle({ update_id: 2, message: message(-100) });
  await f.bridge.handle({ update_id: 3, message: message(-100, 8) });
  await f.bridge.handle({ update_id: 4, message: message(-200) });
  assert.equal(f.created.length, 3);
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[0].id, f.sent[1].id);
  assert.notEqual(f.sent[0].id, f.sent[2].id);
  assert.notEqual(f.sent[0].id, f.sent[3].id);
  assert.deepEqual(f.created[0].config, {
    provider: "example/model",
    systemPrompt: "Help the team",
  });
  assert.equal(f.created[0].labels?.["paseo-bots.bot"], undefined);
  assert.equal(
    Object.values(f.store.state.jobs).every((job) => job.delivery === "done"),
    true,
  );
});

test("existing chat binding preserves the agent and requires explicit cross-conversation sharing", async () => {
  const f = await fixture(
    config({ kind: "agent", agentId: "original", sharedHistory: false }),
  );
  await f.bridge.handle({ update_id: 1, message: message(-100) });
  await f.bridge.handle({ update_id: 2, message: message(-200) });
  assert.equal(f.created.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, "original");
  assert.match(f.store.state.jobs[2].answer!, /already bound/);
  f.connection.target = {
    kind: "agent",
    agentId: "original",
    sharedHistory: true,
  };
  await f.bridge.handle({ update_id: 3, message: message(-200) });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, "original");
});

test("a saved non-resident chat resumes before receiving its next Telegram request", async () => {
  const f = await fixture(config({ kind: "agent", agentId: "saved", sharedHistory: false }));
  const agent = f.api.agents.ref("saved");
  const snapshot = (await agent.refresh())!;
  const refetch = agent.timeline.refetch;
  let loaded = false;
  agent.refresh = async () => ({ ...snapshot, agent: { ...snapshot.agent, status: loaded ? "idle" : "closed" } });
  agent.timeline.refetch = async (options) => {
    loaded = true;
    return refetch(options);
  };
  await f.bridge.handle({ update_id: 1, message: message(-100) });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, "saved");
  assert.equal(f.store.state.jobs[1].dispatch, "sent");
  assert.equal(f.store.state.jobs[1].failure, undefined);
});

test("a reused workspace chat resumes before dispatch without creating another agent", async () => {
  const f = await fixture();
  await f.bridge.handle({ update_id: 1, message: message(-100) });
  const agent = f.api.agents.ref(f.sent[0].id);
  const snapshot = (await agent.refresh())!;
  const refetch = agent.timeline.refetch;
  let loaded = false;
  agent.refresh = async () => ({ ...snapshot, agent: { ...snapshot.agent, status: loaded ? "idle" : "closed" } });
  agent.timeline.refetch = async (options) => { loaded = true; return refetch(options); };
  await f.bridge.handle({ update_id: 2, message: message(-100) });
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].id, f.sent[1].id);
  assert.equal(f.store.state.jobs[2].dispatch, "sent");
  assert.equal(f.store.state.jobs[2].failure, undefined);
});

test("a group-specific route overrides the default without touching other groups", async () => {
  const f = await fixture();
  f.connection.bindings["-100:0"] = {
    kind: "agent",
    agentId: "special",
    sharedHistory: false,
  };
  await f.bridge.handle({ update_id: 1, message: message(-100) });
  await f.bridge.handle({ update_id: 2, message: message(-200) });
  assert.equal(f.sent[0].id, "special");
  assert.notEqual(f.sent[1].id, "special");
});

test("untrusted users/groups cannot invoke agents; explicit group policy allows participants", async () => {
  const f = await fixture();
  assert.equal(
    authorized(f.connection, f.store.state, message(-100, 0, 20)),
    false,
  );
  await f.bridge.handle({ update_id: 1, message: message(-100, 0, 20) });
  await f.bridge.handle({ update_id: 2, message: message(-999) });
  assert.equal(f.sent.length, 0);
  assert.equal(f.telegram.calls.length, 0);
  f.connection.policy.groupUsers = "everyone";
  await f.bridge.handle({ update_id: 3, message: message(-100, 0, 20) });
  assert.equal(f.sent.length, 1);
  f.connection.enabled = false;
  await f.bridge.handle({ update_id: 4, message: message(-100) });
  assert.equal(f.sent.length, 1);
});

test("only the owner can admit groups; a promotion does not revoke admission", async () => {
  const f = await fixture();
  const membership = (actor: number, old = "left", next = "member") => ({
    update_id: 1,
    my_chat_member: {
      chat: { id: -300, type: "supergroup", title: "New" },
      from: { id: actor },
      date: 100,
      old_chat_member: { status: old },
      new_chat_member: { status: next },
    },
  });
  await f.bridge.handle(membership(999));
  assert.equal(f.store.state.groups["-300"], undefined);
  assert.equal(f.telegram.calls.at(-1)?.method, "leaveChat");
  await f.bridge.handle(membership(10));
  assert.ok(f.store.state.groups["-300"]);
  await f.bridge.handle(membership(999, "member", "administrator"));
  assert.ok(f.store.state.groups["-300"]);
  await f.bridge.handle(membership(999, "administrator", "left"));
  assert.equal(f.store.state.groups["-300"], undefined);
});

test("group admission policies are independent of request permissions", async () => {
  for (const mode of ["owner", "operators", "approval", "everyone"] as const) {
    for (const actor of [10, 20, 99]) {
      const f = await fixture();
      f.connection.policy.groupAdmission = mode;
      f.connection.policy.operators = [20];
      await f.bridge.handle({
        update_id: 1,
        my_chat_member: {
          chat: { id: -300, type: "supergroup", title: "New group" },
          from: { id: actor },
          date: 100,
          old_chat_member: { status: "left" },
          new_chat_member: { status: "member" },
        },
      });
      const admitted =
        mode === "everyone" ||
        (mode !== "approval" &&
          (actor === 10 || (mode === "operators" && actor === 20)));
      assert.equal(
        !!f.store.state.groups["-300"],
        admitted,
        `${mode}/${actor}`,
      );
      assert.equal(!!f.store.state.pendingGroups["-300"], mode === "approval");
      assert.equal(
        f.telegram.calls.some((c) => c.method === "leaveChat"),
        !admitted && mode !== "approval",
      );
      await f.bridge.handle({ update_id: 2, message: message(-300, 0, 99) });
      assert.equal(f.sent.length, 0, "admission must not grant request access");
      if (admitted) {
        f.connection.policy.groupUsers = "everyone";
        await f.bridge.handle({ update_id: 3, message: message(-300, 0, 99) });
        assert.equal(f.sent.length, 1);
      }
    }
  }
});

test("pending groups survive pairing and reload without becoming authorized", async () => {
  const f = await fixture();
  f.connection.policy.groupAdmission = "approval";
  f.store.state.ownerId = null;
  const nonce = "d".repeat(32);
  f.store.state.pairing = {
    hash: createHash("sha256").update(nonce).digest("hex"),
    expiresAt: Date.now() + 30_000,
  };
  await f.bridge.handle({
    update_id: 1,
    my_chat_member: {
      chat: { id: -300, type: "supergroup", title: "Pending" },
      from: { id: 10 },
      date: 100,
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member" },
    },
  });
  await f.bridge.handle({
    update_id: 2,
    message: { ...message(10), text: `/start owner_${nonce}` },
  });
  assert.ok(f.store.state.pendingGroups["-300"]);
  assert.equal(f.store.state.groups["-300"], undefined);
  await f.bridge.handle({ update_id: 3, message: message(-300) });
  assert.equal(f.sent.length, 0);
  await f.bridge.handle({
    update_id: 4,
    message: {
      ...message(-300),
      text: "/status@demo_help_bot",
      entities: [],
    },
  });
  assert.match(
    String(f.telegram.calls.at(-1)?.payload.text),
    /awaiting approval/,
  );
  const reloaded = new Store(f.root);
  await reloaded.load();
  assert.ok(reloaded.state.pendingGroups["-300"]);
  assert.equal(reloaded.state.groups["-300"], undefined);
  assert.equal(
    f.telegram.calls.some((c) => c.method === "leaveChat"),
    false,
  );
  await f.bridge.handle({
    update_id: 5,
    message: { ...message(-300), migrate_to_chat_id: -400 },
  });
  assert.equal(f.store.state.pendingGroups["-300"], undefined);
  assert.ok(f.store.state.pendingGroups["-400"]);
  await f.bridge.handle({
    update_id: 6,
    my_chat_member: {
      chat: { id: -400, type: "supergroup" },
      from: { id: 10 },
      date: 100,
      old_chat_member: { status: "member" },
      new_chat_member: { status: "left" },
    },
  });
  assert.equal(f.store.state.pendingGroups["-400"], undefined);
});

test("admin requests require verified Telegram roles and fail closed", async () => {
  const f = await fixture();
  f.connection.policy.groupUsers = "admins";
  f.connection.policy.operators = [20];
  const bot = { status: "administrator", user: { id: 77 } };
  const member = { status: "administrator", user: { id: 20 } };
  f.telegram.administrators = async () => [bot, member];
  await f.bridge.handle({ update_id: 1, message: message(-100, 0, 20) });
  assert.equal(f.sent.length, 1);
  assert.ok(
    f.telegram.calls.filter((c) => c.method === "getChatAdministrators")
      .length >= 3,
  );
  const calls = f.telegram.calls.length;
  await f.bridge.handle({
    update_id: 2,
    message: {
      ...message(-100, 0, 20),
      text: "Ordinary group chatter",
      entities: [],
    },
  });
  await f.bridge.handle({ update_id: 3, message: message(-999, 0, 20) });
  assert.equal(
    f.telegram.calls.length,
    calls,
    "unaddressed or unadmitted messages must not fetch roles",
  );
  for (const [index, lookup] of [
    async () => [bot],
    async () => {
      throw new Error("Telegram is unavailable");
    },
    async () => ({ unexpected: true }),
  ].entries()) {
    f.telegram.administrators = lookup;
    await f.bridge.handle({
      update_id: index + 4,
      message: message(-100, 0, 20),
    });
    assert.equal(
      f.sent.length,
      1,
      "allowed IDs must not bypass the admins policy",
    );
  }
  assert.match(f.bridge.lastError!, /could not be verified/);
  f.telegram.administrators = async () => [{ ...member, status: "creator" }];
  await f.bridge.handle({ update_id: 9, message: message(-100, 0, 20) });
  assert.equal(
    f.sent.length,
    2,
    "human roles do not require the bot itself in the administrator list",
  );
  f.telegram.administrators = async () => {
    assert.fail("owner and DMs do not require group admin lookups");
  };
  await f.bridge.handle({ update_id: 10, message: message(-100) });
  await f.bridge.handle({ update_id: 11, message: message(10) });
  assert.equal(f.sent.length, 4);
});

test("an admin demoted before queued work starts cannot dispatch to the agent", async () => {
  const queue = new AgentQueue(),
    f = await fixture(config(), sdk(), queue);
  f.connection.policy.groupUsers = "admins";
  let release!: () => void, seen!: () => void;
  const ready = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const gate = queue.run(
    `conversation:${f.connection.id}:-100:0`,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  let members = [
    { status: "administrator", user: { id: 77 } },
    { status: "creator", user: { id: 20 } },
  ];
  f.telegram.administrators = async () => {
    const current = members;
    seen();
    return current;
  };
  const request = f.bridge.handle({
    update_id: 1,
    message: message(-100, 0, 20),
  });
  await ready;
  members = [members[0]];
  release();
  await Promise.all([gate, request]);
  assert.equal(f.sent.length, 0);
  assert.equal(f.created.length, 0);
  assert.equal(f.store.state.jobs["1"].delivery, "canceled");
});

test("service replies stay English for Cyrillic requests", async () => {
  const f = await fixture();
  await f.bridge.handle({
    update_id: 1,
    message: { ...message(10), text: "/status проверка" },
  });
  const text = String(f.telegram.calls.at(-1)?.payload.text);
  assert.match(text, /^Ready:/);
  assert.doesNotMatch(text, /\p{Script=Cyrillic}/u);
});

test("owner pairing is private, expiring, and consumed exactly once", async () => {
  const f = await fixture();
  f.store.state.ownerId = null;
  const nonce = "a".repeat(32);
  f.store.state.pairing = {
    hash: createHash("sha256").update(nonce).digest("hex"),
    expiresAt: Date.now() - 1,
  };
  const start = { ...message(10), text: `/start owner_${nonce}` };
  await f.bridge.handle({ update_id: 1, message: start });
  assert.equal(f.store.state.ownerId, null);
  f.store.state.pairing.expiresAt = Date.now() + 1000;
  await f.bridge.handle({
    update_id: 2,
    message: { ...start, text: `/start owner_${"b".repeat(32)}` },
  });
  assert.equal(f.store.state.ownerId, null);
  await f.bridge.handle({ update_id: 3, message: start });
  assert.equal(f.store.state.ownerId, 10);
  assert.equal(f.store.state.pairing, null);
  await f.bridge.handle({
    update_id: 4,
    message: { ...start, from: { id: 999 } },
  });
  assert.equal(f.store.state.ownerId, 10);
});

test("Telegram setup commands only invite a request when this conversation has a saved destination", async () => {
  for (const command of ["/start", "/status"]) {
    const f = await fixture(config(null));
    const status = { ...message(10), text: command };
    await f.bridge.handle({ update_id: 1, message: status });
    assert.match(
      String(f.telegram.calls.at(-1)?.payload.text),
      /Setup incomplete/,
    );
    assert.match(
      String(f.telegram.calls.at(-1)?.payload.text),
      /Save settings/,
    );
    assert.equal(f.sent.length, 0);

    f.connection.bindings["-100:0"] = config().target!;
    await f.bridge.handle({ update_id: 2, message: status });
    assert.match(
      String(f.telegram.calls.at(-1)?.payload.text),
      /Setup incomplete/,
    );

    f.connection.bindings["10:0"] = config().target!;
    await f.bridge.handle({ update_id: 3, message: status });
    assert.match(String(f.telegram.calls.at(-1)?.payload.text), /Ready/);
    assert.doesNotMatch(
      String(f.telegram.calls.at(-1)?.payload.text),
      /Setup incomplete/,
    );
    assert.equal(f.sent.length, 0);

    await f.bridge.handle({
      update_id: 4,
      message: {
        ...message(-100, 8),
        text: `${command}@demo_help_bot`,
        entities: [
          { type: "bot_command", offset: 0, length: command.length + 14 },
        ],
      },
    });
    assert.match(String(f.telegram.calls.at(-1)?.payload.text), /Ready/);
    await f.bridge.handle({
      update_id: 5,
      message: {
        ...message(-200, 8),
        text: `${command}@demo_help_bot`,
        entities: [
          { type: "bot_command", offset: 0, length: command.length + 14 },
        ],
      },
    });
    assert.match(
      String(f.telegram.calls.at(-1)?.payload.text),
      /Setup incomplete/,
    );
    const replies = f.telegram.calls.length;
    for (const unauthorized of [
      { ...message(-999, 8), text: `${command}@demo_help_bot` },
      { ...message(10, 0, 999), text: command },
      { ...message(-100, 8), text: `${command}@another_bot` },
    ]) {
      await f.bridge.handle({ update_id: 6, message: unauthorized });
      assert.equal(f.telegram.calls.length, replies);
    }
    f.connection.target = config().target;
    delete f.connection.bindings["10:0"];
    await f.bridge.handle({
      update_id: 7,
      message: { ...message(10), text: command },
    });
    assert.match(String(f.telegram.calls.at(-1)?.payload.text), /Ready/);
    assert.equal(f.sent.length, 0);
  }
});

test("owner pairing explains the next setup step based on the saved destination", async () => {
  for (const target of [null, config().target]) {
    const f = await fixture(config(target));
    const nonce = "c".repeat(32);
    f.store.state.ownerId = null;
    f.store.state.pairing = {
      hash: createHash("sha256").update(nonce).digest("hex"),
      expiresAt: Date.now() + 30_000,
    };
    await f.bridge.handle({
      update_id: 1,
      message: { ...message(10), text: `/start owner_${nonce}` },
    });
    assert.match(
      String(f.telegram.calls.at(-1)?.payload.text),
      /Owner confirmed/,
    );
    assert.match(
      String(f.telegram.calls.at(-1)?.payload.text),
      target ? /already has a saved Paseo destination/ : /Save settings/,
    );
    assert.deepEqual(f.telegram.calls.at(-1)?.payload.reply_markup, {
      inline_keyboard: [
        [
          {
            text: "Add to group",
            url: "https://t.me/demo_help_bot?startgroup&admin=manage_chat",
          },
        ],
      ],
    });
    assert.equal(f.sent.length, 0);
  }
});

test("a duplicate update never sends the same agent operation twice", async () => {
  const f = await fixture();
  const update = { update_id: 42, message: message() };
  await f.bridge.handle(update);
  await f.bridge.handle(update);
  assert.equal(f.sent.length, 1);
  assert.notEqual(
    messageIdentity(f.connection.id, 42),
    messageIdentity(randomUUID(), 42),
  );
});

test("interrupted dispatch checks exact message identity and refuses a changed timeline", async () => {
  const f = sdk(),
    agent = f.api.agents.ref("a");
  assert.equal(
    await findDispatch(agent, "message", { epoch: "epoch", seq: 0 }),
    false,
  );
  f.histories.set("a", [
    { seqEnd: 1, item: { type: "user_message", messageId: "message" } },
  ]);
  assert.equal(
    await findDispatch(agent, "message", { epoch: "epoch", seq: 0 }),
    true,
  );
  await assert.rejects(
    findDispatch(agent, "message", { epoch: "old", seq: 0 }),
    /history changed/,
  );
});

test("an existing sent job resumes waiting without replaying the user's request", async () => {
  const f = await fixture();
  const update = { update_id: 42, message: message() };
  f.store.state.jobs[42] = {
    message: update.message,
    agentId: "existing",
    dispatch: "sent",
  };
  await f.bridge.handle(update);
  assert.equal(f.sent.length, 0);
  assert.match(f.store.state.jobs[42].answer!, /Done by existing/);
});

test("two bots sharing an existing agent serialize their requests", async () => {
  const shared = sdk(),
    queue = new AgentQueue();
  const target: Target = {
    kind: "agent",
    agentId: "shared",
    sharedHistory: true,
  };
  const first = await fixture(config(target), shared, queue),
    second = await fixture(config(target), shared, queue);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let waits = 0;
  shared.setWait(async () => {
    if (++waits === 1) {
      entered();
      await hold;
    }
    return { status: "idle", lastMessage: "Done" };
  });
  const a = first.bridge.handle({ update_id: 1, message: message() });
  await started;
  const b = second.bridge.handle({ update_id: 1, message: message() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shared.sent.length, 1);
  release();
  await Promise.all([a, b]);
  assert.equal(shared.sent.length, 2);
});

test("registry keeps tokens separate, rejects duplicate bots and stale concurrent saves", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-telegram-registry-")),
    registry = new Registry(root);
  await registry.load();
  const token = `123456789:${"x".repeat(35)}`;
  const value = await registry.add("Demo", token, {
    id: 77,
    username: "demo_help_bot",
  });
  assert.equal(
    (await readFile(join(root, "connections.json"), "utf8")).includes(token),
    false,
  );
  assert.equal(await registry.token(value.id), token);
  assert.equal(
    (await stat(join(root, "secrets", `${value.id}.json`))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    registry.add("Duplicate", token, { id: 77, username: "demo_help_bot" }),
    /already connected/,
  );
  const updated = await registry.update({ ...value, name: "Updated" });
  assert.equal(updated.revision, 1);
  await assert.rejects(
    registry.update({ ...value, name: "Stale" }),
    /another client/,
  );
});

test("local daemon discovery accepts IPC and loopback only", () => {
  assert.deepEqual(localTarget("/tmp/paseo.sock"), {
    url: "ws+unix:///tmp/paseo.sock:/ws",
    socketPath: "/tmp/paseo.sock",
  });
  assert.equal(localTarget("0.0.0.0:6767").url, "ws://127.0.0.1:6767/ws");
  assert.throws(() => localTarget("remote.example:6767"), /loopback/);
  assert.throws(() => localTarget("127.0.0.1:99999"), /loopback/);
});

test("Bots integration fails explicitly when selected but remains optional", async () => {
  const adapter = new BotsAdapter(async () => {
    throw new Error("not installed");
  }, null);
  assert.equal((await adapter.choices()).botsAvailable, false);
  await assert.rejects(
    adapter.config("bot", randomUUID(), "Help", sdk().api),
    /unavailable/,
  );
});

test("the global binding guard also prevents accidental sharing across separate bots", async () => {
  const f = await fixture(
    config({ kind: "agent", agentId: "private", sharedHistory: false }),
  );
  const router = new Router(
    f.api,
    new BotsAdapter(async () => null, null),
    f.store,
    () => f.connection,
    () => false,
  );
  const bridge = new Bridge(
    f.telegram,
    f.store,
    router,
    () => f.connection,
    new AgentQueue(),
  );
  await bridge.handle({ update_id: 1, message: message() });
  assert.equal(f.sent.length, 0);
  assert.match(f.store.state.jobs[1].answer!, /already bound/);
});

test("pausing an active receiver preserves its pending job and never stops its agent", async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setWait(async () => {
    entered();
    return new Promise(() => {});
  });
  const task = f.bridge.handle({ update_id: 1, message: message() });
  await started;
  await f.bridge.stop();
  await task;
  assert.equal(f.store.state.jobs[1].dispatch, "sent");
  assert.equal(f.store.state.jobs[1].delivery, undefined);
  assert.equal(f.sent.length, 1);
});

test("native questions are answered only by a reply in the exact chat and topic", async () => {
  const f = await fixture();
  let answers: unknown;
  const agent = f.api.agents.ref("question-agent");
  agent.refresh = async () =>
    ({
      agent: {
        id: "question-agent",
        status: "running",
        activeTurn: { turnId: "blocked-turn" },
        pendingPermissions: [
          {
            id: "question",
            name: "request_user_input",
            kind: "question",
            input: {},
          },
        ],
      },
    }) as never;
  agent.respondToPermission = async (value) => {
    answers = value;
  };
  f.store.state.jobs[1] = {
    agentId: "question-agent",
    destination: { chatId: -100, topicId: 0 },
    delivery: "done",
    question: {
      requestId: "question",
      fields: [{ header: "Mode", text: "Choose", options: ["A", "B"] }],
      status: "pending",
      messageId: 99,
    },
  };
  const reply = {
    ...message(-100, 8),
    text: "2",
    reply_to_message: { message_id: 99, from: { id: 77 } },
  };
  await f.bridge.handle({ update_id: 2, message: reply });
  assert.equal(answers, undefined);
  await f.bridge.handle({
    update_id: 3,
    message: { ...reply, message_thread_id: undefined },
  });
  assert.deepEqual(answers, {
    requestId: "question",
    response: { behavior: "allow", updatedInput: { answers: { Mode: "B" } } },
  });
  assert.equal(f.store.state.jobs[1].question!.status, "answered");
  assert.equal(f.store.state.jobs[3].answer, "Done by question-agent");
});

test("a clarification reply unblocks its running task without waiting behind it", async () => {
  const f = await fixture(config({ kind: "agent", agentId: "active", sharedHistory: false }));
  const agent = f.api.agents.ref("active");
  const permission = {
    id: "live-question", kind: "question", name: "request_user_input_async",
    input: { questions: [{ header: "Example", question: "Which example?", options: [] }] },
  };
  let answered = false;
  const snapshot = () => ({
    status: f.sent.length && !answered ? "running" : "idle",
    activeTurn: f.sent.length && !answered ? { turnId: "turn" } : null,
    pendingPermissions: f.sent.length && !answered ? [permission] : [],
  });
  agent.refresh = async () => ({ agent: { id: "active", ...snapshot() } }) as never;
  agent.respondToPermission = async () => { answered = true; };
  f.setWait(async () => ({
    status: answered ? "idle" : "permission",
    final: snapshot(), lastMessage: answered ? "Here is the example" : "Checking",
  }));
  const running = f.bridge.handle({ update_id: 1, message: message() });
  try {
    for (let n = 0; n < 100 && !f.store.state.jobs[1]?.question?.messageId; n++)
      await new Promise(resolve => setTimeout(resolve, 5));
    const formId = f.store.state.jobs[1]?.question?.messageId;
    assert.ok(formId, "the active task must publish its question");
    const reply = f.bridge.handle({ update_id: 2, message: {
      ...message(), message_id: 102, text: "Any example",
      reply_to_message: { message_id: formId, from: { id: 77 } },
    } });
    for (let n = 0; n < 60 && !answered; n++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(answered, true, "a control reply must reach the agent before the original task can finish");
    await Promise.all([running, reply]);
    assert.equal(f.sent.length, 1, "the answer uses the native question RPC, not a second prompt");
    assert.equal(f.store.state.jobs[1].answer, "Here is the example");
    assert.match(f.store.state.jobs[2].answer!, /Answer received/);
    const deleted = f.telegram.calls.filter(c => c.method === "deleteMessages").flatMap(c => c.payload.message_ids as number[]);
    assert.ok(deleted.includes(f.store.state.jobs[2].finalReply!.messageIds[0]), "the control acknowledgement belongs to the original task's temporary messages");
    assert.ok(!deleted.includes(formId), "the meaningful clarification stays in history");
    assert.ok(!deleted.includes(102), "the person's answer stays in history");
  } finally { await f.bridge.stop(); await running; }
});

test("an outstanding question from an earlier request is not reposted under a new task", async () => {
  const f = await fixture(config({ kind: "agent", agentId: "existing", sharedHistory: false }));
  const agent = f.api.agents.ref("existing");
  const permission = {
    id: "old-question", kind: "question", name: "request_user_input_async",
    input: { questions: [{ header: "Old", question: "Unrelated old question?", options: [] }] },
  };
  agent.refresh = async () => ({ agent: {
    id: "existing", status: "idle", activeTurn: null, pendingPermissions: [permission],
  } }) as never;
  let calls = 0;
  f.setWait(async () => ({
    status: "permission", lastMessage: ++calls === 1 ? "Working" : "New task answer",
    final: { status: calls === 1 ? "running" : "idle", activeTurn: calls === 1 ? { turnId: "new" } : null, pendingPermissions: [permission] },
  }));
  await f.bridge.handle({ update_id: 1, message: message() });
  assert.equal(f.store.state.jobs[1].answer, "New task answer");
  assert.equal(f.store.state.jobs[1].question, undefined);
  assert.equal(f.telegram.calls.filter(c => c.method === "sendMessage" && String(c.payload.text).startsWith("Clarification:")).length, 0);
});

test("a fresh question is still delivered when an older form remains pending", async () => {
  const f = await fixture(config({ kind: "agent", agentId: "existing", sharedHistory: false }));
  const agent = f.api.agents.ref("existing");
  const old = { id: "old", kind: "question", name: "request_user_input_async", input: {
    questions: [{ header: "Old", question: "Old question?", options: [] }],
  } };
  const fresh = { ...old, id: "fresh", input: { questions: [{ header: "New", question: "New question?", options: [] }] } };
  agent.refresh = async () => ({ agent: { id: "existing", status: "idle", pendingPermissions: [old] } }) as never;
  let calls = 0;
  f.setWait(async () => ({ status: "permission", lastMessage: "Done", final: {
    status: ++calls === 1 ? "running" : "idle", activeTurn: calls === 1 ? { turnId: "turn" } : null,
    pendingPermissions: [old, fresh],
  } }));
  await f.bridge.handle({ update_id: 1, message: message() });
  const forms = f.telegram.calls.filter(c => c.method === "sendMessage" && String(c.payload.text).startsWith("Clarification:"));
  assert.equal(forms.length, 1);
  assert.match(String(forms[0].payload.text), /New question/);
  assert.equal(f.store.state.jobs[1].question?.requestId, "fresh");
});

test("an idle asynchronous question resumes a follow-up and returns its new final answer", async () => {
  const f = await fixture();
  const agent = f.api.agents.ref("idle-question");
  agent.refresh = async () => ({ agent: { id: "idle-question", status: "idle", activeTurn: null,
    pendingPermissions: [{ id: "question", kind: "question", name: "request_user_input_async", input: {} }],
  } }) as never;
  let replies = 0;
  agent.respondToPermission = async () => {
    replies++;
    f.histories.set("idle-question", [{ seqEnd: 1, item: { type: "user_message" } }]);
  };
  f.store.state.jobs[1] = {
    agentId: "idle-question", destination: { chatId: -100, topicId: 0 }, delivery: "done",
    question: { requestId: "question", fields: [{ header: "Mode", text: "Choose", options: [] }], status: "pending", messageId: 99 },
  };
  await f.bridge.handle({ update_id: 2, message: { ...message(), text: "Example", reply_to_message: { message_id: 99, from: { id: 77 } } } });
  assert.equal(replies, 1);
  assert.equal(f.store.state.jobs[2].answer, "Done by idle-question");
  assert.equal(f.sent.length, 0);
});

test("an interrupted question response is never replayed or falsely acknowledged", async () => {
  const f = await fixture();
  f.store.state.jobs[1] = {
    agentId: "question-agent", destination: { chatId: -100, topicId: 0 }, delivery: "done",
    question: { requestId: "question", fields: [{ header: "Mode", text: "Choose", options: [] }], status: "responding", messageId: 99 },
  };
  const reply = { ...message(), text: "Example", reply_to_message: { message_id: 99, from: { id: 77 } } };
  f.store.state.jobs[2] = {
    agentId: "question-agent", message: reply,
    questionReply: { sourceJobId: "1", answers: { Mode: "Example" }, attempted: true, continuesInPlace: true },
  };
  await f.bridge.handle({ update_id: 2, message: reply });
  assert.match(f.store.state.jobs[2].answer!, /could not be confirmed/);
  assert.equal(f.sent.length, 0);
});

test("a repeated reply to a completed question is not dispatched as a new prompt", async () => {
  const f = await fixture();
  f.store.state.jobs[1] = {
    agentId: "question-agent", destination: { chatId: -100, topicId: 0 }, delivery: "done",
    question: { requestId: "question", fields: [{ header: "Mode", text: "Choose", options: [] }], status: "answered", messageId: 99 },
  };
  await f.bridge.handle({ update_id: 2, message: { ...message(), text: "Example", reply_to_message: { message_id: 99, from: { id: 77 } } } });
  assert.match(f.store.state.jobs[2].answer!, /already been answered/);
  assert.equal(f.sent.length, 0);
});

test("recovery does not repost an old form from pre-upgrade task receipts", async () => {
  const f = await fixture();
  const permission = { id: "old", kind: "question", name: "request_user_input_async", input: {
    questions: [{ header: "Old", question: "Old question?", options: [] }],
  } };
  f.store.state.jobs[1] = {
    agentId: "existing", delivery: "done",
    question: { requestId: "old", fields: [{ header: "Old", text: "Old question?", options: [] }], status: "pending", messageId: 99 },
  };
  f.store.state.jobs[2] = { agentId: "existing", dispatch: "sent", after: { epoch: "epoch", seq: 0 } };
  f.setWait(async () => ({ status: "permission", lastMessage: "Current result", final: {
    status: "idle", activeTurn: null, pendingPermissions: [permission],
  } }));
  await f.bridge.handle({ update_id: 2, message: message() });
  assert.equal(f.store.state.jobs[2].answer, "Current result");
  assert.equal(f.store.state.jobs[2].question, undefined);
  assert.equal(f.sent.length, 0);
});

test("a demoted admin cannot answer a native question, and the owner can still answer it", async () => {
  const f = await fixture();
  f.connection.policy.groupUsers = "admins";
  let members = [{ status: "administrator", user: { id: 20 } }];
  f.telegram.administrators = async () => members;
  const agent = f.api.agents.ref("question-agent");
  let answered = false;
  agent.refresh = async () => {
    members = [];
    return {
      agent: {
        id: "question-agent",
        status: "idle",
        pendingPermissions: [
          {
            id: "question",
            name: "request_user_input",
            kind: "question",
            input: {},
          },
        ],
      },
    } as never;
  };
  agent.respondToPermission = async () => {
    answered = true;
  };
  f.store.state.jobs[1] = {
    agentId: "question-agent",
    destination: { chatId: -100, topicId: 0 },
    delivery: "done",
    question: {
      requestId: "question",
      fields: [{ header: "Mode", text: "Choose", options: ["A", "B"] }],
      status: "pending",
      messageId: 99,
    },
  };
  const reply = {
    ...message(-100, 0, 20),
    text: "2",
    reply_to_message: { message_id: 99, from: { id: 77 } },
  };
  await f.bridge.handle({ update_id: 2, message: reply });
  assert.equal(answered, false);
  assert.equal(f.store.state.jobs[1].question!.status, "pending");
  assert.equal(f.store.state.jobs[2].questionReply?.attempted, undefined);
  await f.bridge.handle({
    update_id: 3,
    message: { ...reply, from: { id: 10 } },
  });
  assert.equal(answered, true);
  assert.equal(f.store.state.jobs[1].question!.status, "answered");
});

test("losing a local creation receipt reuses the native idempotent agent instead of creating another chat", async () => {
  const f = await fixture();
  const originalRef = f.api.workspaces.ref;
  f.api.workspaces.ref = ((id: string) => {
    const workspace = originalRef(id),
      create = workspace.agents.create;
    workspace.agents.create = async (options) => {
      const previous = f.created.find(
        (value) => value.agentId === options.agentId,
      );
      if (previous) {
        assert.ok(
          options.idempotencyKey,
          "creation retries need the SDK's idempotency key",
        );
        return f.api.agents.ref(previous.agentId!);
      }
      return create(options);
    };
    return workspace;
  }) as typeof f.api.workspaces.ref;
  await f.bridge.handle({ update_id: 1, message: message() });
  const original = f.sent[0].id;
  f.store.state.agents = {};
  f.store.state.conversations = {};
  await f.bridge.handle({ update_id: 2, message: message() });
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].id, original);
});

test("a new admitted group receives an English repair link while commands still reach its agent", async () => {
  const f = await fixture();
  f.telegram.canReadAllGroupMessages = false;
  await f.bridge.handle({
    update_id: 100,
    my_chat_member: {
      chat: { id: -300, type: "supergroup", title: "Demo" },
      from: { id: 10 },
      date: 100,
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member" },
    },
  });
  const notice = f.telegram.calls.at(-1)!;
  assert.equal(notice.method, "sendMessage");
  assert.equal(notice.payload.chat_id, -300);
  assert.match(String(notice.payload.text), /Group setup is incomplete/);
  assert.match(String(notice.payload.text), /\/ask@demo_help_bot/);
  assert.doesNotMatch(String(notice.payload.text), /[А-Яа-яЁё]/);
  assert.deepEqual(notice.payload.reply_markup, {
    inline_keyboard: [
      [
        {
          text: "Fix group access",
          url: "https://t.me/demo_help_bot?startgroup&admin=manage_chat",
        },
      ],
    ],
  });
  assert.equal(f.sent.length, 0, "joining must not dispatch agent work");
  await f.bridge.handle({
    update_id: 101,
    message: {
      ...message(-300),
      text: "/ask@demo_help_bot Check this",
      entities: [{ type: "bot_command", offset: 0, length: 18 }],
    },
  });
  assert.equal(
    f.sent.length,
    1,
    "privacy warnings must not block delivered commands",
  );
  await f.bridge.handle({
    update_id: 102,
    message: {
      ...message(-300),
      text: "/status@demo_help_bot",
      entities: [{ type: "bot_command", offset: 0, length: 21 }],
    },
  });
  assert.match(
    String(f.telegram.calls.at(-1)?.payload.text),
    /Group setup is incomplete/,
  );
  assert.doesNotMatch(String(f.telegram.calls.at(-1)?.payload.text), /^Ready/);
  f.telegram.membership = { status: "administrator" };
  await f.bridge.handle({
    update_id: 103,
    my_chat_member: {
      chat: { id: -300, type: "supergroup", title: "Demo" },
      from: { id: 10 },
      date: 100,
      old_chat_member: { status: "member" },
      new_chat_member: { status: "administrator" },
    },
  });
  assert.match(
    String(f.telegram.calls.at(-1)?.payload.text),
    /Group message access is ready/,
  );
  assert.equal(f.bridge.groupSetup.access("-300"), "ready");
});

async function waitingFixture() {
  const f = await fixture(config({ kind: "agent", agentId: "waiting", sharedHistory: false }));
  const agent = f.api.agents.ref("waiting");
  let pending = ["passengers", "statistics"].map((id) => ({
    id, provider: "claude", kind: "tool", name: `mcp__reports__${id}`, input: { sql: "SELECT 1" },
  }));
  let waits = 0;
  const responses: unknown[] = [];
  const snapshot = () => ({
    id: "waiting", provider: "claude", currentModeId: "default",
    availableModes: [{ id: "bypassPermissions", label: "Bypass" }],
    status: f.sent.length && pending.length ? "running" : "idle",
    activeTurn: f.sent.length && pending.length ? { turnId: "turn" } : null,
    pendingPermissions: f.sent.length ? pending : [],
  });
  agent.refresh = async () => ({ agent: snapshot() }) as never;
  agent.respondToPermission = async (value) => {
    responses.push(value);
    pending = pending.filter((request) => request.id !== value.requestId);
  };
  f.setWait(async () => {
    waits++;
    return { status: pending.length ? "permission" : "idle", final: snapshot(),
      lastMessage: pending.length ? "Waiting" : "Actual passenger report", error: null };
  });
  return { ...f, responses, resolveExternally: () => { pending = []; }, waits: () => waits };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition must become true");
}

test("Telegram approvals release the waiting task without finalizing a notice or sending a second model prompt", async () => {
  const f = await waitingFixture();
  const running = f.bridge.handle({ update_id: 1, message: message() });
  try {
    await until(() => !!f.store.state.jobs[1]?.approval?.messageId);
    const job = f.store.state.jobs[1];
    assert.equal(job.delivery, undefined); assert.equal(job.answer, undefined);
    assert.ok(job.message, "the original Telegram message must survive while waiting");
    await f.bridge.handle({ update_id: 2, callback_query: {
      id: "callback", from: { id: 10 }, data: `pa:${job.approval!.token}:once`,
      message: { ...message(), message_id: job.approval!.messageId!, from: { id: 77 } },
    } });
    await running;
    assert.equal(f.responses.length, 2); assert.equal(f.sent.length, 1);
    assert.equal(job.answer, "Actual passenger report"); assert.equal(job.delivery, "done");
    assert.equal(job.approval!.closed, true);
    const final = f.telegram.calls.find(call => call.method === "sendMessage" && call.payload.text === "Actual passenger report");
    assert.ok(final, "the final answer is a new message, not a progress edit");
    assert.deepEqual(final.payload.reply_parameters, { message_id: message().message_id, allow_sending_without_reply: true });
    const deleted = f.telegram.calls.filter(call => call.method === "deleteMessages").flatMap(call => call.payload.message_ids as number[]);
    assert.ok(deleted.includes(job.progress!.messageId!)); assert.ok(deleted.includes(job.approval!.messageId!));
    assert.ok(job.finalReply!.messageIds.every(id => !deleted.includes(id)));
  } finally { await f.bridge.stop(); await running; }
});

test("reload resumes confirmed final chunk boundaries without replaying native work or delivered chunks", async () => {
  for (const alreadySent of [0, 1, 2]) {
    const f = await fixture();
    const answer = "Chunked final. ".repeat(450), chunks = formatReply(answer);
    assert.equal(chunks.length, 2);
    f.store.state.jobs[1] = {
      message: message(), destination: { chatId: -100, topicId: 0 }, answer, delivery: "sending",
      progress: { startedAt: 0, attempted: true, messageId: 500 }, temporaryMessageIds: [500],
      finalReply: { mode: "new", messageIds: [501, 502].slice(0, alreadySent), replyToMessageId: message().message_id, sending: false },
    };
    f.bridge.start();
    try {
      await until(() => f.store.state.jobs[1].delivery === "done" && f.bridge.queued === 0);
      assert.equal(f.sent.length, 0);
      const sent = f.telegram.calls.filter(c => c.method === "sendMessage");
      assert.equal(sent.length, chunks.length - alreadySent);
      if (sent.length) assert.equal(sent[0].payload.text, chunks[alreadySent].text);
      assert.deepEqual(f.telegram.calls.filter(c => c.method === "deleteMessages").flatMap(c => c.payload.message_ids as number[]), [500]);
    } finally { await f.bridge.stop(); }
  }
});

test("reload never treats a new unconfirmed final send as an idempotent legacy edit", async () => {
  const f = await fixture();
  f.store.state.jobs[1] = {
    message: message(), destination: { chatId: -100, topicId: 0 }, answer: "Unknown delivery", delivery: "sending",
    progress: { startedAt: 0, attempted: true, messageId: 500 }, temporaryMessageIds: [500],
    finalReply: { mode: "new", messageIds: [], replyToMessageId: message().message_id, sending: true },
  };
  f.bridge.start();
  try {
    await until(() => f.store.state.jobs[1].delivery === "uncertain");
    assert.equal(f.sent.length, 0);
    assert.equal(f.telegram.calls.some(c => ["sendMessage", "editMessageText", "deleteMessages"].includes(c.method)), false);
  } finally { await f.bridge.stop(); }
});

test("an interrupted legacy final edit remains idempotent and cleanup never deletes that answer", async () => {
  const f = await fixture();
  f.store.state.jobs[1] = {
    message: message(), destination: { chatId: -100, topicId: 0 }, answer: "Recovered old answer", delivery: "sending",
    progress: { startedAt: 0, attempted: true, messageId: 500 }, temporaryMessageIds: [501],
  };
  f.bridge.start();
  try {
    await until(() => f.store.state.jobs[1].delivery === "done" && f.bridge.queued === 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.telegram.calls.some(c => c.method === "sendMessage"), false);
    assert.ok(f.telegram.calls.some(c => c.method === "editMessageText" && c.payload.message_id === 500 && c.payload.text === "Recovered old answer"));
    assert.deepEqual(f.telegram.calls.filter(c => c.method === "deleteMessages").flatMap(c => c.payload.message_ids as number[]), [501]);
  } finally { await f.bridge.stop(); }
});

test("reload recovers a clarification acknowledgement committed before it was linked to the completed source task", async () => {
  const f = await fixture();
  f.store.state.jobs[1] = {
    destination: { chatId: -100, topicId: 0 }, answer: "Actual answer", delivery: "done", temporaryMessageIds: [],
    finalReply: { mode: "new", messageIds: [500], replyToMessageId: 100 },
    question: { requestId: "q", fields: [], status: "answered", messageId: 501 },
  };
  f.store.state.jobs[2] = {
    destination: { chatId: -100, topicId: 0 }, answer: "Answer received", delivery: "done", temporaryMessageIds: [],
    finalReply: { mode: "new", messageIds: [502], replyToMessageId: 101, service: true },
    questionReply: { sourceJobId: "1", answers: {}, continuesInPlace: true },
  };
  f.bridge.start();
  try {
    await until(() => f.telegram.calls.some(c => c.method === "deleteMessages"));
    await f.bridge.messages.settle();
    assert.deepEqual(f.telegram.calls.filter(c => c.method === "deleteMessages").flatMap(c => c.payload.message_ids as number[]), [502]);
    assert.equal(f.telegram.calls.some(c => c.method === "sendMessage"), false);
    assert.equal(f.sent.length, 0);
    await f.bridge.stop();
    const saved = new Store(f.root); await saved.load();
    assert.equal(saved.state.jobs[2].questionReply?.acknowledgementLinked, true, "a completed ownership transfer is durable and does not restart cleanup on every reload");
  } finally { await f.bridge.stop(); }
});

test("a reloaded receiver resumes a pending approval and delivers a decision made in Paseo", async () => {
  const f = await waitingFixture();
  const running = f.bridge.handle({ update_id: 1, message: message() });
  await until(() => !!f.store.state.jobs[1]?.approval?.messageId);
  const originalCard = f.store.state.jobs[1].approval!.messageId;
  await f.bridge.stop(); await running;
  const store = new Store(f.root); await store.load();
  const router = new Router(f.api, new BotsAdapter(async () => assert.fail("not used"), null), store, () => f.connection);
  const receiver = new Bridge(f.telegram, store, router, () => f.connection, new AgentQueue());
  const priorWaits = f.waits();
  receiver.start();
  try {
    await until(() => f.waits() > priorWaits);
    assert.equal(store.state.jobs[1].approval!.messageId, originalCard);
    f.resolveExternally();
    await until(() => store.state.jobs[1].delivery === "done");
    assert.equal(store.state.jobs[1].answer, "Actual passenger report");
    assert.equal(f.sent.length, 1); assert.equal(f.responses.length, 0);
    assert.equal(f.telegram.calls.filter((call) => call.method === "sendMessage" && String(call.payload.text).startsWith("Approval required")).length, 1);
  } finally { await receiver.stop(); }
});

test("new agent permissions come from the bot profile and later profile edits preserve its existing conversation", async () => {
  const connection = config();
  if (connection.target?.kind !== "workspace" || connection.target.profile.kind !== "custom") assert.fail();
  connection.target.profile.modeId = "bypassPermissions";
  const f = await fixture(connection);
  await f.bridge.handle({ update_id: 1, message: message() });
  assert.equal((f.created[0].config as any).modeId, "bypassPermissions");
  connection.target.profile.modeId = "default";
  await f.bridge.handle({ update_id: 2, message: message() });
  assert.equal(f.created.length, 1); assert.equal(f.sent[0].id, f.sent[1].id);
});
