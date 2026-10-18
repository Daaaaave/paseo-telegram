import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("public package has independent runtime entries and no mandatory Bots dependency", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.name, "paseo-telegram");
  assert.equal(pkg.private, undefined);
  assert.equal(
    Object.keys(pkg.dependencies).some((name) => /bots|zerosub/.test(name)),
    false,
  );
  assert.equal(pkg.files.includes("index.server.ts"), true);
  assert.equal(pkg.files.includes("index.client.tsx"), true);
});
