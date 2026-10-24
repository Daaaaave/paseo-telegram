import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import {
  Approvals,
  rememberedPermissions,
  type Permission,
} from "../server/approvals.ts";
import { AgentQueue } from "../server/routing.ts";
import { Telegram } from "../server/telegram.ts";
import { Store, type Job } from "../server/store.ts";
import { authorized } from "../server/policy.ts";
import { connectionSchema } from "../shared/config.ts";
import type { TelegramMessage } from "../shared/telegram.ts";

function request(id: string): Permission {
  const name = `mcp__reports__${id}`;
  return {
    id,
    provider: "claude",
    name,
    kind: "tool",
    input: { sql: "SELECT table_name FROM information_schema.tables" },
    suggestions: [
      {
        type: "addRules",
        behavior: "allow",
        destination: "localSettings",
        rules: [{ toolName: name }],
      },
    ],
  };
}
class Recorder extends Telegram {
  calls: { method: string; payload: Record<string, unknown> }[] = [];
  failure?: string;
  override async call<T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ method, payload });
    if (method === this.failure) throw new Error("unavailable");
    return { message_id: 1000 } as T;
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-approval-")),
    store = new Store(root),
    telegram = new Recorder();
  const connection = connectionSchema.parse({
    id: randomUUID(),
    name: "Demo",
    enabled: true,
    botId: 77,
    username: "demo_help_bot",
    target: { kind: "agent", agentId: "agent", sharedHistory: false },
    policy: { groupUsers: "everyone" },
    bindings: {},
    revision: 0,
  });
  store.state.ownerId = 10;
  store.state.groups["-100"] = { title: "Demo", addedBy: 10, addedAt: 100 };
  const message: TelegramMessage = {
    message_id: 9,
    date: 100,
    chat: { id: -100, type: "supergroup" },
    message_thread_id: 8,
    from: { id: 10 },
    text: "Check the report",
  };
  const job: Job = {
    agentId: "agent",
    message,
    destination: { chatId: -100, topicId: 8 },
    dispatch: "sent",
  };
  store.state.jobs[1] = job;
  const responses: Parameters<
    ReturnType<PaseoApi["agents"]["ref"]>["respondToPermission"]
  >[0][] = [];
  let pending = [request("passengers"), request("statistics")],
    mode = "default";
  let responseFailure = false,
    modeFailure = false;
  let beforeResponse: (() => void) | undefined;
  const agent = {
    refresh: async () => ({
      agent: {
        id: "agent",
        provider: "claude",
        status: "running",
        currentModeId: mode,
        pendingPermissions: pending,
        availableModes: [
          { id: "default", label: "Always Ask" },
          { id: "bypassPermissions", label: "Bypass" },
        ],
      },
    }),
    respondToPermission: async (value: (typeof responses)[number]) => {
      beforeResponse?.();
      responses.push(value);
      if (responseFailure) throw new Error("RPC acknowledgement lost");
      pending = pending.filter((request) => request.id !== value.requestId);
    },
  };
  const api = { agents: { ref: () => agent } } as unknown as PaseoApi;
  const controller = new AbortController();
  const modeCalls: string[] = [];
  const options = {
    telegram,
    store,
    api,
    queue: new AgentQueue(),
    connection: () => connection,
    signal: controller.signal,
    authorized: async (value: TelegramMessage) =>
      authorized(connection, store.state, value),
    setMode: async (_id: string, value: string) => {
      modeCalls.push(value);
      if (modeFailure) throw new Error("Mode failed");
      mode = value;
    },
  };
  const approvals = new Approvals(options);
  const show = () => approvals.show(job, pending);
  const callback = (action: string, user = 10) => ({
    id: randomUUID(),
    from: { id: user },
    data: `pa:${job.approval!.token}:${action}`,
    message: {
      ...message,
      message_id: job.approval!.messageId!,
      from: { id: 77 },
    },
  });
  const command = (text: string, user = 10): TelegramMessage => ({
    ...message,
    from: { id: user },
    text,
    reply_to_message: { message_id: job.approval!.messageId, from: { id: 77 } },
  });
  return {
    root,
    store,
    connection,
    telegram,
    job,
    approvals,
    agent,
    options,
    show,
    callback,
    command,
    responses,
    modeCalls,
    pending: () => pending,
    setPending: (value: Permission[]) => {
      pending = value;
    },
    failResponse: () => {
      responseFailure = true;
    },
    failMode: () => {
      modeFailure = true;
    },
    beforeResponse: (operation: () => void) => {
      beforeResponse = operation;
    },
  };
}

test("one English approval card aggregates requests, offers full access, and never links out to Paseo", async () => {
  const f = await fixture();
  await f.show();
  await f.show();
  const cards = f.telegram.calls.filter(
    (call) => call.method === "sendMessage",
  );
  assert.equal(cards.length, 1);
  assert.match(String(cards[0].payload.text), /Approval required · 2 actions/);
  assert.doesNotMatch(
    JSON.stringify(cards[0].payload),
    /Open in Paseo|[А-Яа-яЁё]/,
  );
  assert.match(
    JSON.stringify(cards[0].payload.reply_markup),
    /Grant full access/,
  );
  assert.match(
    JSON.stringify(cards[0].payload.reply_markup),
    /Always allow these tools/,
  );
  for (const row of (cards[0].payload.reply_markup as any).inline_keyboard)
    for (const button of row)
      assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  assert.equal(f.responses.length, 0);
});

test("allow once resolves both exact requests, persists receipts before native calls, and ignores duplicate clicks", async () => {
  const f = await fixture();
  await f.show();
  const click = f.callback("once");
  f.beforeResponse(() =>
    assert.ok(
      Object.values(f.job.approvalAttempts!).some(
        (value) => value.status === "sending",
      ),
    ),
  );
  await Promise.all([f.approvals.callback(click), f.approvals.callback(click)]);
  assert.deepEqual(
    f.responses.map((r) => r.requestId),
    ["passengers", "statistics"],
  );
  assert.ok(
    f.responses.every(
      (r) =>
        r.response.behavior === "allow" &&
        !("updatedPermissions" in r.response),
    ),
  );
  assert.equal(f.job.approval!.closed, true);
  const persisted = new Store(f.root);
  await persisted.load();
  assert.equal(
    persisted.state.jobs[1].approvalAttempts!.statistics.status,
    "confirmed",
  );
});

test("remember uses exact provider tool grants; mode changes, broad wildcards and unrelated tools are excluded", async () => {
  const f = await fixture();
  await f.show();
  await f.approvals.callback(f.callback("remember"));
  for (const response of f.responses) {
    assert.equal(response.response.behavior, "allow");
    if (response.response.behavior === "allow")
      assert.deepEqual(
        response.response.updatedPermissions,
        request(response.requestId).suggestions,
      );
  }
  for (const suggestion of [
    { type: "setMode", mode: "bypassPermissions" },
    {
      type: "addRules",
      behavior: "allow",
      destination: "localSettings",
      rules: [{ toolName: "*" }],
    },
    {
      type: "addRules",
      behavior: "allow",
      destination: "userSettings",
      rules: [{ toolName: request("a").name }],
    },
    {
      type: "addRules",
      behavior: "allow",
      destination: "localSettings",
      rules: [{ toolName: "unrelated" }],
    },
  ])
    assert.deepEqual(
      rememberedPermissions({ ...request("a"), suggestions: [suggestion] }),
      [],
    );
});

test("full access changes the same chat's native mode and releases already open tools without changing the profile", async () => {
  const f = await fixture();
  await f.show();
  const target = structuredClone(f.connection.target);
  await f.approvals.callback(f.callback("full"));
  assert.deepEqual(f.modeCalls, ["bypassPermissions"]);
  assert.equal(
    (await f.agent.refresh()).agent.currentModeId,
    "bypassPermissions",
  );
  assert.equal(f.responses.length, 2);
  assert.equal(f.job.agentId, "agent");
  assert.deepEqual(f.connection.target, target);
  assert.equal(f.job.modeGrant!.confirmed, true);
  const failed = await fixture();
  await failed.show();
  failed.failMode();
  await failed.approvals.callback(failed.callback("full"));
  assert.equal(failed.responses.length, 0);
  assert.equal(failed.job.modeGrant!.confirmed, false);
});

test("request permission and Telegram admin status do not grant approval authority; designated approvers do", async () => {
  const f = await fixture();
  await f.show();
  await f.approvals.callback(f.callback("once", 99));
  assert.equal(f.responses.length, 0);
  f.connection.policy.approvers = [20];
  await f.approvals.callback(f.callback("once", 20));
  assert.equal(f.responses.length, 2);
});

test("copied card tokens, wrong topic/message/bot, revoked admission and disabled connections cannot approve", async () => {
  for (const change of [
    (q: ReturnType<Awaited<ReturnType<typeof fixture>>["callback"]>) => {
      q.message.chat.id = -999;
    },
    (q: ReturnType<Awaited<ReturnType<typeof fixture>>["callback"]>) => {
      q.message.message_thread_id = 9;
    },
    (q: ReturnType<Awaited<ReturnType<typeof fixture>>["callback"]>) => {
      q.message.message_id++;
    },
    (q: ReturnType<Awaited<ReturnType<typeof fixture>>["callback"]>) => {
      q.message.from.id = 88;
    },
  ]) {
    const f = await fixture();
    await f.show();
    const q = f.callback("full");
    change(q);
    await f.approvals.callback(q);
    assert.equal(f.responses.length, 0);
    assert.equal(f.modeCalls.length, 0);
  }
  for (const revoke of ["group", "enabled", "origin"] as const) {
    const f = await fixture();
    await f.show();
    if (revoke === "group") delete f.store.state.groups["-100"];
    if (revoke === "enabled") f.connection.enabled = false;
    if (revoke === "origin") {
      f.job.message!.from = { id: 99 };
      f.connection.policy.groupUsers = "operators";
    }
    await f.approvals.callback(f.callback("full"));
    assert.equal(f.responses.length, 0);
    assert.equal(f.modeCalls.length, 0);
  }
});

test("an altered native request invalidates its card before any action; external resolutions do not replay", async () => {
  const f = await fixture();
  await f.show();
  const q = f.callback("once");
  f.setPending([
    { ...request("passengers"), input: { sql: "changed" } },
    request("statistics"),
  ]);
  await f.approvals.callback(q);
  assert.equal(f.responses.length, 0);
  assert.notEqual(f.job.approval!.token, q.data.split(":")[1]);
  await f.approvals.callback(q);
  assert.equal(f.responses.length, 0);
  const g = await fixture();
  await g.show();
  g.setPending([request("statistics")]);
  await g.approvals.callback(g.callback("once"));
  assert.deepEqual(
    g.responses.map((r) => r.requestId),
    ["statistics"],
  );
});

test("commands require a reply to the exact card and never become model prompts", async () => {
  const f = await fixture();
  await f.show();
  assert.equal(
    await f.approvals.command({
      ...f.command("/approve"),
      reply_to_message: undefined,
    }),
    true,
  );
  assert.equal(f.responses.length, 0);
  assert.equal(
    await f.approvals.command(f.command("/approve@another_bot")),
    false,
  );
  await f.approvals.command({ ...f.command("/approve"), message_thread_id: 9 });
  assert.equal(f.responses.length, 0);
  await f.approvals.command(f.command("/approve"));
  assert.equal(f.responses.length, 2);
  const denied = await fixture();
  await denied.show();
  await denied.approvals.command(denied.command("/deny"));
  assert.ok(denied.responses.every((r) => r.response.behavior === "deny"));
});

test("uncertain permission RPCs are not replayed after reload; callback proves an uncertain card send's ID", async () => {
  const f = await fixture();
  await f.show();
  f.failResponse();
  await f.approvals.callback(f.callback("once"));
  assert.equal(f.responses.length, 1);
  assert.equal(f.job.approvalAttempts!.passengers.status, "uncertain");
  const restored = new Store(f.root);
  await restored.load();
  const receiver = new Approvals({ ...f.options, store: restored });
  const old = restored.state.jobs[1];
  await receiver.show(old, f.pending());
  await receiver.callback(f.callback("once"));
  assert.equal(
    f.responses.filter((r) => r.requestId === "passengers").length,
    1,
  );
  const uncertain = await fixture();
  uncertain.telegram.failure = "sendMessage";
  await assert.rejects(uncertain.show(), /could not be confirmed/);
  assert.equal(uncertain.job.approval!.messageId, undefined);
  uncertain.telegram.failure = undefined;
  const callback = uncertain.callback("once");
  callback.message.message_id = 1000;
  await uncertain.approvals.callback(callback);
  assert.equal(uncertain.responses.length, 2);
});

test("unsupported remembered grants cannot grant full access, and native action choices remain explicit", async () => {
  const f = await fixture();
  f.setPending([
    {
      ...request("a"),
      actions: [
        { id: "limited", label: "Allow once", behavior: "allow" },
        { id: "wide", label: "Allow for session", behavior: "allow" },
        { id: "no", label: "Deny", behavior: "deny" },
      ],
    },
  ]);
  await f.show();
  await f.approvals.callback(f.callback("once"));
  assert.equal(f.responses.length, 0);
  await f.approvals.callback(f.callback("a0_0"));
  assert.deepEqual(f.responses[0].response, {
    behavior: "allow",
    selectedActionId: "limited",
  });
});

test("an approver revoked after the first response cannot authorize the second request", async () => {
  const f = await fixture();
  f.connection.policy.approvers = [20];
  await f.show();
  f.beforeResponse(() => {
    f.connection.policy.approvers = [];
  });
  await f.approvals.callback(f.callback("once", 20));
  assert.deepEqual(
    f.responses.map((r) => r.requestId),
    ["passengers"],
  );
});

test("a continuation cannot reuse its predecessor's approval card", async () => {
  const f = await fixture();
  await f.show();
  const old = f.callback("full");
  f.job.agentId = "continued-agent";
  await f.approvals.callback(old);
  assert.equal(f.modeCalls.length, 0);
  assert.equal(f.responses.length, 0);
  await f.show();
  assert.equal(f.job.approval!.agentId, "continued-agent");
  assert.notEqual(f.job.approval!.token, old.data.split(":")[1]);
});

test("permission previews suppress JSON credentials and private keys", async () => {
  for (const input of [
    { password: "example-secret-value" },
    { nested: { api_key: "example-key-value" } },
    { key: "-----BEGIN OPENSSH PRIVATE KEY-----" },
  ]) {
    const f = await fixture();
    f.setPending([{ ...request("a"), input }]);
    await f.show();
    const card = f.telegram.calls.find(
      (call) => call.method === "sendMessage",
    )!;
    assert.doesNotMatch(
      String(card.payload.text),
      /example-secret-value|example-key-value|BEGIN OPENSSH/,
    );
    assert.match(String(card.payload.text), /Input preview omitted/);
  }
});
