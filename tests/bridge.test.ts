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
  override async call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.calls.push({ method, payload });
    if (method === "getMe") return { id: 77, username: "demo_help_bot" } as T;
    if (method === "getWebhookInfo") return { url: "" } as T;
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
