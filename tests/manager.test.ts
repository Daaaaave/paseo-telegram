import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../server/registry.ts";
import { Store } from "../server/store.ts";
import { Manager } from "../server/manager.ts";
import { collectPages } from "../server/pages.ts";
import { Telegram, TelegramError } from "../server/telegram.ts";
import { policySchema } from "../shared/config.ts";
import { saveRpc, reviewRpc } from "../shared/contracts.ts";

class GroupTelegram extends Telegram {
  calls: string[] = [];
  member: unknown = { status: "member" };
  failure?: Error;
  override async call<T>(method: string): Promise<T> {
    this.calls.push(method);
    if (this.failure) throw this.failure;
    return (method === "getChatMember" ? this.member : true) as T;
  }
}
async function pendingFixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-telegram-review-"));
  const registry = new Registry(root);
  await registry.load();
  let config = await registry.add("Review", `123456789:${"x".repeat(35)}`, {
    id: 77,
    username: "demo_help_bot",
  });
  config = await registry.update({
    ...config,
    enabled: false,
    policy: {
      ...config.policy,
      groupAdmission: "approval",
      groupUsers: "operators",
    },
  });
  const state = new Store(join(root, "connections", config.id));
  state.state.ownerId = 10;
  state.state.pendingGroups["-300"] = {
    title: "New group",
    addedBy: 99,
    addedAt: 100,
  };
  state.state.agents["existing"] = "existing-agent";
  await state.save();
  const telegram = new GroupTelegram();
  const manager = new Manager(
    root,
    root,
    async () => assert.fail("group review needs no model connection"),
    () => telegram,
  );
  return { manager, config, telegram, state };
}

test("Paseo approval admits only a pending group and preserves request permissions and history", async () => {
  const f = await pendingFixture();
  try {
    assert.equal(
      (await f.manager.list()).connections[0].pendingGroups.length,
      1,
    );
    await f.manager.review(f.config.id, "-300", true);
    await f.state.load();
    assert.ok(f.state.state.groups["-300"]);
    assert.equal(f.state.state.pendingGroups["-300"], undefined);
    assert.equal(f.state.state.agents.existing, "existing-agent");
    assert.equal(
      f.manager.registry.get(f.config.id).policy.groupUsers,
      "operators",
    );
    assert.deepEqual(f.telegram.calls, ["getChatMember"]);
    await assert.rejects(
      f.manager.review(f.config.id, "-300", true),
      /no longer waiting/,
    );
    await f.manager.revoke(f.config.id, "-300");
    await f.state.load();
    assert.equal(f.state.state.groups["-300"], undefined);
  } finally {
    await f.manager.stop();
  }
});

test("failed membership verification cannot approve a group; rejection leaves without granting access", async () => {
  for (const status of ["left", "kicked", "restricted"]) {
    const f = await pendingFixture();
    try {
      f.telegram.member = { status, is_member: false };
      await assert.rejects(
        f.manager.review(f.config.id, "-300", true),
        /no longer in this group/,
      );
      f.telegram.failure = new TelegramError(500);
      await assert.rejects(f.manager.review(f.config.id, "-300", true));
      await assert.rejects(f.manager.review(f.config.id, "-300", false));
      await f.state.load();
      assert.ok(f.state.state.pendingGroups["-300"]);
      assert.equal(f.state.state.groups["-300"], undefined);
      f.telegram.failure = undefined;
      assert.deepEqual(await f.manager.review(f.config.id, "-300", false), {
        approved: false,
      });
      await f.state.load();
      assert.equal(f.state.state.pendingGroups["-300"], undefined);
      assert.equal(f.state.state.groups["-300"], undefined);
      assert.equal(f.telegram.calls.at(-1), "leaveChat");
      assert.equal(f.state.state.agents.existing, "existing-agent");
    } finally {
      await f.manager.stop();
    }
  }
});

test("legacy policies keep owner-only admission, and old save payloads cannot reset the new policy", async () => {
  assert.equal(
    policySchema.parse({ groupUsers: "everyone" }).groupAdmission,
    "owner",
  );
  const f = await pendingFixture();
  try {
    const { groupAdmission: omitted, ...legacyPolicy } = f.config.policy;
    const input = saveRpc.input.parse({
      id: f.config.id,
      revision: f.config.revision,
      name: f.config.name,
      enabled: false,
      target: null,
      bindings: {},
      policy: legacyPolicy,
    });
    assert.equal(input.policy.groupAdmission, undefined);
    const saved = await f.manager.save(input);
    assert.equal(saved.policy.groupAdmission, "approval");
    assert.equal(saved.policy.groupUsers, "operators");
    await assert.rejects(
      f.manager.review(f.config.id, "-999", true),
      /no longer waiting/,
    );
  } finally {
    await f.manager.stop();
  }
});

test("group review requires pairing and the saved approval policy, and accepts only safe group IDs", async () => {
  for (const paired of [false, true]) {
    const f = await pendingFixture();
    try {
      if (!paired) {
        f.state.state.ownerId = null;
        await f.state.save();
      } else {
        await f.manager.save({
          ...f.config,
          policy: { ...f.config.policy, groupAdmission: "owner" },
        });
      }
      await assert.rejects(
        f.manager.review(f.config.id, "-300", true),
        paired ? /approval admission policy/ : /Confirm the owner/,
      );
      assert.equal(f.telegram.calls.length, 0);
      for (const chatId of ["10", "-9007199254740993", "-1;command"]) {
        assert.equal(
          reviewRpc.input.safeParse({ id: f.config.id, chatId, approve: true })
            .success,
          false,
        );
      }
    } finally {
      await f.manager.stop();
    }
  }
});

test("a broken or missing destination does not prevent pausing the connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-telegram-pause-"));
  const registry = new Registry(root);
  await registry.load();
  let value = await registry.add("Demo", `123456789:${"x".repeat(35)}`, {
    id: 77,
    username: "demo_help_bot",
  });
  value = await registry.update({
    ...value,
    target: { kind: "agent", agentId: "deleted-agent", sharedHistory: false },
  });
  const manager = new Manager(root, root, async () =>
    assert.fail("pausing must not require a live SDK connection"),
  );
  const paused = await manager.save({ ...value, enabled: false });
  assert.equal(paused.enabled, false);
  await manager.stop();
});

test("corrupt persisted state is not silently replaced with an empty history", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-telegram-corrupt-"));
  await writeFile(join(root, "state.json"), '{"version":999,"ownerId":10}');
  await assert.rejects(new Store(root).load());
});

test("destination discovery follows every page and detects broken pagination", async () => {
  const seen: (string | undefined)[] = [];
  const result = await collectPages(async (cursor) => {
    seen.push(cursor);
    return {
      entries: [cursor ? "second" : "first"],
      pageInfo: { hasMore: !cursor, nextCursor: cursor ? null : "next" },
    };
  });
  assert.deepEqual(result.entries, ["first", "second"]);
  assert.deepEqual(seen, [undefined, "next"]);
  await assert.rejects(
    collectPages(async () => ({
      entries: [],
      pageInfo: { hasMore: true, nextCursor: "same" },
    })),
    /repeated page cursor/,
  );
});
