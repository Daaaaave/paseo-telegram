import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../server/registry.ts";
import { Store } from "../server/store.ts";
import { Manager } from "../server/manager.ts";
import { collectPages } from "../server/pages.ts";

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
