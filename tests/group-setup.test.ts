import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectionSchema } from "../shared/config.ts";
import { connectionViewSchema } from "../shared/contracts.ts";
import { groupInviteUrl, groupAccessText } from "../shared/group-setup.ts";
import { GroupSetup } from "../server/group-setup.ts";
import { Store } from "../server/store.ts";
import { Telegram } from "../server/telegram.ts";

class SetupTelegram extends Telegram {
  calls: string[] = [];
  identity = { id: 77, can_read_all_group_messages: false };
  member: { status: string; is_member?: boolean } = { status: "member" };
  failIdentity = false;
  failMember = false;
  waitMember?: () => Promise<unknown>;
  override async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    if (method === "getMe") {
      if (this.failIdentity) throw new Error("unavailable");
      return this.identity as T;
    }
    assert.equal(
      method,
      "getChatMember",
      "setup checks must never change Telegram permissions",
    );
    if (this.failMember) throw new Error("unavailable");
    return (this.waitMember ? await this.waitMember() : this.member) as T;
  }
}
function fixture() {
  const connection = connectionSchema.parse({
    id: randomUUID(),
    name: "Demo",
    enabled: true,
    botId: 77,
    username: "demo_help_bot",
    target: null,
    policy: {},
    bindings: {},
    revision: 0,
  });
  // These tests exercise in-memory health only; no state or token files are written.
  const store = new Store("unused");
  store.state.groups["-100"] = {
    title: "Demo group",
    addedBy: 10,
    addedAt: 100,
  };
  const telegram = new SetupTelegram(),
    controller = new AbortController();
  let time = 0;
  const setup = new GroupSetup(
    telegram,
    store,
    () => connection,
    controller.signal,
    () => time,
  );
  return {
    setup,
    store,
    telegram,
    controller,
    connection,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("default Telegram privacy requires an admin; disabled privacy and admin membership support mentions", async () => {
  const f = fixture();
  assert.equal(f.setup.access("-100"), "checking");
  await f.setup.refresh();
  assert.equal(f.setup.privacy, "enabled");
  assert.equal(f.setup.access("-100"), "needs_admin");
  f.telegram.member = { status: "administrator" };
  await f.setup.refresh(true);
  assert.equal(f.setup.access("-100"), "ready");
  f.telegram.member = { status: "member" };
  f.telegram.identity.can_read_all_group_messages = true;
  await f.setup.refresh(true);
  assert.equal(f.setup.privacy, "disabled");
  assert.equal(f.setup.access("-100"), "ready");
  for (const status of ["left", "kicked", "restricted"]) {
    f.telegram.member = { status, is_member: false };
    await f.setup.refresh(true);
    assert.equal(f.setup.access("-100"), "not_member");
  }
});

test("failed checks remove stale readiness and never change group admission or invocation policies", async () => {
  const f = fixture();
  f.telegram.identity.can_read_all_group_messages = true;
  await f.setup.refresh();
  assert.equal(f.setup.access("-100"), "ready");
  const groups = structuredClone(f.store.state.groups);
  const policy = structuredClone(f.connection.policy);
  f.telegram.failMember = true;
  await f.setup.refresh(true);
  assert.equal(f.setup.access("-100"), "checking");
  f.telegram.failMember = false;
  f.telegram.failIdentity = true;
  await f.setup.refresh(true);
  assert.equal(f.setup.privacy, "unknown");
  assert.equal(f.setup.access("-100"), "checking");
  f.telegram.failIdentity = false;
  f.telegram.identity.id = 99;
  await f.setup.refresh(true);
  assert.equal(f.setup.access("-100"), "checking");
  assert.deepEqual(f.store.state.groups, groups);
  assert.deepEqual(f.connection.policy, policy);
});

test("background checks are cached, manual checks refresh immediately, and stopped receivers do not query Telegram", async () => {
  const f = fixture();
  await f.setup.refresh();
  await f.setup.refresh();
  assert.equal(f.telegram.calls.length, 2);
  f.advance(60_000);
  await f.setup.refresh();
  assert.equal(f.telegram.calls.length, 4);
  await f.setup.refresh(true);
  assert.equal(f.telegram.calls.length, 6);
  f.controller.abort();
  await f.setup.refresh(true);
  assert.equal(f.telegram.calls.length, 6);
});

test("a newer promotion event wins over an in-flight membership check; simultaneous checks coalesce", async () => {
  const f = fixture();
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.telegram.waitMember = () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = f.setup.refresh(),
    second = f.setup.refresh(true);
  await started;
  f.setup.observe("-100", { status: "administrator" });
  release({ status: "member" });
  await Promise.all([first, second]);
  assert.equal(f.setup.access("-100"), "ready");
  assert.deepEqual(f.telegram.calls, ["getMe", "getChatMember"]);
});

test("invitations request only manage_chat, and setup text is English with an immediately usable command", () => {
  const url = new URL(groupInviteUrl("demo_help_bot"));
  assert.equal(url.origin, "https://t.me");
  assert.equal(url.pathname, "/demo_help_bot");
  assert.ok(url.searchParams.has("startgroup"));
  assert.equal(url.searchParams.get("admin"), "manage_chat");
  const warning = groupAccessText("demo_help_bot", "needs_admin");
  assert.match(warning, /\/ask@demo_help_bot/);
  assert.doesNotMatch(warning, /[А-Яа-яЁё]/);
});

test("older connection views default to unverified group access instead of green readiness", () => {
  const f = fixture();
  const view = connectionViewSchema.parse({
    config: f.connection,
    ownerId: 10,
    running: true,
    lastError: null,
    queued: 0,
    groups: [{ id: "-100", title: "Legacy group" }],
    conversations: [],
  });
  assert.equal(view.groupPrivacy, "unknown");
  assert.equal(view.groups[0].access, "checking");
});
