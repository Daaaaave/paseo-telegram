import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { BotsAdapter } from "../server/bots.ts";

test("a Bots profile contributes its configuration and tools without exposing secrets in choices", async () => {
  const bot = {
    id: "support",
    name: "Support",
    provider: "codex",
    model: "model",
    modeId: "review",
    thinkingOptionId: "high",
    hostId: null as string | null,
    archived: false,
    mcpServerIds: ["files"],
    alwaysAllow: ["files/read", "missing/write"],
    soul: "Help customers",
  };
  const calls: string[] = [];
  const adapter = new BotsAdapter(async (_plugin, method) => {
    calls.push(method);
    if (method === "settings.bots.read")
      return {
        status: "ready",
        values: {
          bots: [bot],
          library: {
            mcpServers: [
              {
                id: "files",
                name: "files",
                enabled: true,
                config: {
                  type: "stdio",
                  command: "fixture-tool",
                  env: { KEY: "PRIVATE_FIXTURE_CANARY" },
                },
              },
            ],
          },
        },
      };
    if (method === "bots.system-prompt")
      return { systemPrompt: "Composed profile, memory and skills" };
    if (method === "bots.mount")
      return {
        tools: { type: "http", url: "http://127.0.0.1:1/fixture" },
        apps: null,
      };
    return {};
  }, "local");
  const choices = await adapter.choices();
  assert.deepEqual(choices.bots, [{ id: "support", name: "Support" }]);
  assert.equal(
    JSON.stringify(choices).includes("PRIVATE_FIXTURE_CANARY"),
    false,
  );
  const result = await adapter.config(
    "support",
    randomUUID(),
    "Help",
    {} as PaseoApi,
  );
  assert.equal(result.config.provider, "codex/model");
  assert.equal(result.config.modeId, "review");
  assert.equal(
    result.config.systemPrompt,
    "Composed profile, memory and skills",
  );
  assert.equal(result.labels["paseo-bots.bot"], "support");
  assert.ok(result.config.mcpServers?.bots);
  assert.deepEqual(result.config.toolPolicy?.preapproved, [
    { kind: "mcp", server: "files", tool: "read" },
  ]);
  assert.ok(calls.includes("bots.hello"));
  bot.hostId = "another-host";
  await assert.rejects(
    adapter.config("support", randomUUID(), "Help", {} as PaseoApi),
    /not available on this host/,
  );
});
