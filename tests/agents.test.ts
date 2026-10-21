import test from "node:test";
import assert from "node:assert/strict";
import type { PaseoApi } from "@getpaseo/client";
import { refreshLinkedAgent } from "../server/agents.ts";

type Agent = ReturnType<PaseoApi["agents"]["ref"]>;

test("a dormant saved chat is loaded through its timeline before checking readiness", async () => {
  const calls: string[] = [];
  let loaded = false;
  const agent = {
    refresh: async () => {
      calls.push("refresh");
      return { agent: { status: loaded ? "idle" : "closed", archivedAt: null } };
    },
    timeline: { refetch: async (input: unknown) => {
      calls.push("timeline");
      assert.deepEqual(input, { direction: "tail", limit: 1 });
      loaded = true;
      return { entries: [], error: null };
    } },
    send: () => assert.fail("Loading the chat must not send a participant message"),
  } as unknown as Agent;
  assert.equal((await refreshLinkedAgent(agent))?.agent.status, "idle");
  assert.deepEqual(calls, ["refresh", "timeline", "refresh"]);
});

test("archived, missing and already resident chats are never loaded by a readiness check", async () => {
  for (const value of [null, { agent: { status: "closed", archivedAt: "2026-01-01" } },
    { agent: { status: "running", archivedAt: null } }, { agent: { status: "idle", archivedAt: null } }]) {
    const agent = { refresh: async () => value, timeline: { refetch: () => assert.fail("Unexpected session load") } } as unknown as Agent;
    assert.equal(await refreshLinkedAgent(agent), value);
  }
});

test("a failed session load reports a fixed error without exposing provider details", async () => {
  const agent = {
    refresh: async () => ({ agent: { status: "closed", archivedAt: null } }),
    timeline: { refetch: async () => ({ error: "private provider details" }) },
  } as unknown as Agent;
  await assert.rejects(refreshLinkedAgent(agent), error => error instanceof Error &&
    /could not be resumed/.test(error.message) && !error.message.includes("private"));
});
