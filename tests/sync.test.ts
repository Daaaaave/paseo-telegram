import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { synchronizeWorktree, syncIsComplete } from "../server/sync.ts";
import { Router, routeIdentity } from "../server/routing.ts";
import { BotsAdapter } from "../server/bots.ts";
import { Store, type Job } from "../server/store.ts";
import { connectionSchema } from "../shared/config.ts";
import type { PaseoApi } from "@getpaseo/client";
import type { TelegramMessage } from "../shared/telegram.ts";

const run = promisify(execFile);
const branch = "bots/telegram-support-test";
async function git(folder: string, ...args: string[]): Promise<string> {
  return (
    await run("git", ["-C", folder, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    })
  ).stdout.trim();
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "telegram-support-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const source = join(root, "source");
  const repo = join(root, "repo");
  const folder = join(root, "bot");
  await run("git", ["init", "--bare", origin]);
  await run("git", ["init", "--initial-branch=main", source]);
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.invalid");
  await writeFile(join(source, "shared.txt"), "initial\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initial");
  await git(source, "remote", "add", "origin", origin);
  await git(source, "push", "-u", "origin", "main");
  await run("git", ["clone", "--branch", "main", origin, repo]);
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.invalid");
  await git(repo, "worktree", "add", "-b", branch, folder, "origin/main");
  const update = async (path = "upstream.txt", contents = "new upstream\n") => {
    await writeFile(join(source, path), contents);
    await git(source, "add", ".");
    await git(source, "commit", "-m", "upstream change");
    await git(source, "push");
    return git(source, "rev-parse", "HEAD");
  };
  return { origin, source, repo, folder, update };
}

test("a new message fetches remote changes and fast-forwards only its clean bot checkout", async (t) => {
  const f = await fixture(t);
  const main = await git(f.repo, "rev-parse", "HEAD");
  const upstream = await f.update();
  assert.notEqual(
    await git(f.folder, "rev-parse", "origin/main"),
    upstream,
    "the fixture begins with a stale remote-tracking ref",
  );
  const result = await synchronizeWorktree(f.folder, branch);
  assert.equal(result.reason, "fast_forward");
  assert.equal(result.state, "ready");
  assert.equal(result.upstream, upstream);
  assert.equal(await git(f.folder, "rev-parse", "HEAD"), upstream);
  assert.equal(
    await git(f.repo, "rev-parse", "HEAD"),
    main,
    "the main checkout is untouched",
  );
  assert.equal((await synchronizeWorktree(f.folder, branch)).reason, "current");
});

test("Git synchronization resumes a dormant agent before requiring it to be idle", async (t) => {
  const f = await fixture(t);
  const upstream = await f.update();
  const config = connectionSchema.parse({
    id: "00000000-0000-4000-8000-000000000001", name: "Fixture", enabled: true,
    botId: 77, username: "demo_help_bot", revision: 0, policy: {}, bindings: {},
    target: { kind: "workspace", workspaceId: "workspace", git: { remote: "origin", branch: "main" },
      profile: { kind: "custom", provider: "example/model", systemPrompt: "Help" } },
  });
  const identity = routeIdentity(config.id, "-100:0", config.target!);
  const store = new Store(join(f.folder, "..", "connector"));
  store.state.agents[identity.key] = identity.agentId;
  store.state.conversations[identity.key] = {
    key: "-100:0", title: "Fixture", agentId: identity.agentId,
    workspaceId: "workspace", routeKey: identity.key, folder: f.folder, branch,
  };
  let loaded = false;
  const agent = {
    refresh: async () => ({ agent: { id: identity.agentId, cwd: f.folder,
      status: loaded ? "idle" : "closed", activeTurn: null, archivedAt: null } }),
    timeline: { refetch: async () => { loaded = true; return { entries: [], error: null }; } },
    send: () => assert.fail("Preparation must not send the request"),
  };
  const api = { agents: { ref: () => agent } } as unknown as PaseoApi;
  const router = new Router(api, new BotsAdapter(async () => null, null), store, () => config);
  const job: Job = {};
  const message: TelegramMessage = { message_id: 1, date: 100,
    chat: { id: -100, type: "supergroup" }, from: { id: 10 }, text: "Check current code" };
  const prepared = await router.prepare(message, job);
  assert.equal(prepared.id, identity.agentId);
  assert.equal(loaded, true);
  assert.equal(job.sync?.state, "ready");
  assert.equal(job.sync?.reason, "fast_forward");
  assert.equal(await git(f.folder, "rev-parse", "HEAD"), upstream);
});

test("divergent committed work merges main without rewriting the bot commit", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.folder, "feature.txt"), "local feature\n");
  await git(f.folder, "add", ".");
  await git(f.folder, "commit", "-m", "bot feature");
  const own = await git(f.folder, "rev-parse", "HEAD");
  const upstream = await f.update();
  await git(f.repo, "config", "--unset", "user.name");
  await git(f.repo, "config", "--unset", "user.email");
  const result = await synchronizeWorktree(f.folder, branch);
  assert.equal(result.reason, "merge");
  assert.equal(result.state, "ready");
  assert.equal(await git(f.folder, "rev-parse", "HEAD^1"), own);
  assert.equal(await git(f.folder, "rev-parse", "HEAD^2"), upstream);
  assert.equal(
    await git(f.folder, "log", "-1", "--format=%an <%ae>"),
    "Paseo Telegram <paseo-telegram@localhost>",
  );
  assert.equal(
    await readFile(join(f.folder, "feature.txt"), "utf8"),
    "local feature\n",
  );
  assert.equal(
    await readFile(join(f.folder, "upstream.txt"), "utf8"),
    "new upstream\n",
  );
  assert.equal(await syncIsComplete(f.folder, branch, upstream), true);
});

test("dirty tracked, staged and untracked work is preserved byte-for-byte for the agent", async (t) => {
  const f = await fixture(t);
  const head = await git(f.folder, "rev-parse", "HEAD");
  await writeFile(join(f.folder, "shared.txt"), "staged work\n");
  await git(f.folder, "add", "shared.txt");
  await writeFile(join(f.folder, "shared.txt"), "additional unstaged work\n");
  await writeFile(join(f.folder, "upstream.txt"), "untracked collision\n");
  const status = await git(f.folder, "status", "--porcelain=v1");
  const staged = await git(f.folder, "diff", "--cached");
  const diff = await git(f.folder, "diff");
  const upstream = await f.update();
  const result = await synchronizeWorktree(f.folder, branch);
  assert.equal(result.state, "attention");
  assert.equal(result.reason, "dirty");
  assert.equal(result.upstream, upstream);
  assert.equal(await git(f.folder, "status", "--porcelain=v1"), status);
  assert.equal(await git(f.folder, "diff", "--cached"), staged);
  assert.equal(await git(f.folder, "diff"), diff);
  assert.equal(
    await readFile(join(f.folder, "upstream.txt"), "utf8"),
    "untracked collision\n",
  );
  assert.equal(await git(f.folder, "rev-parse", "HEAD"), head);
  assert.equal(await git(f.folder, "stash", "list"), "");
  assert.equal(await syncIsComplete(f.folder, branch, upstream), false);
});

test("merge conflicts remain intact and later requests do not start another merge", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.folder, "shared.txt"), "bot change\n");
  await git(f.folder, "add", ".");
  await git(f.folder, "commit", "-m", "bot change");
  const own = await git(f.folder, "rev-parse", "HEAD");
  const upstream = await f.update("shared.txt", "upstream change\n");
  const result = await synchronizeWorktree(f.folder, branch);
  assert.equal(result.state, "attention");
  assert.equal(result.reason, "conflict");
  assert.equal(await git(f.folder, "rev-parse", "HEAD"), own);
  assert.equal(await git(f.folder, "rev-parse", "MERGE_HEAD"), upstream);
  const index = await git(f.folder, "ls-files", "--stage");
  const conflict = await readFile(join(f.folder, "shared.txt"), "utf8");
  assert.equal(
    (await synchronizeWorktree(f.folder, branch)).reason,
    "operation",
  );
  assert.equal(await git(f.folder, "ls-files", "--stage"), index);
  assert.equal(await readFile(join(f.folder, "shared.txt"), "utf8"), conflict);
  assert.equal(await syncIsComplete(f.folder, branch, upstream), false);
  await writeFile(
    join(f.folder, "shared.txt"),
    "bot and upstream reconciled\n",
  );
  await git(f.folder, "add", ".");
  await git(f.folder, "commit", "--no-edit");
  assert.equal(await syncIsComplete(f.folder, branch, upstream), true);
});

test("an ignored file colliding with main is not overwritten", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.folder, ".gitignore"), "private.txt\n");
  await git(f.folder, "add", ".gitignore");
  await git(f.folder, "commit", "-m", "ignore private file");
  await writeFile(join(f.folder, "private.txt"), "private local work\n");
  await f.update("private.txt", "tracked upstream\n");
  const result = await synchronizeWorktree(f.folder, branch);
  assert.equal(result.state, "attention");
  assert.equal(result.reason, "dirty");
  assert.equal(
    await readFile(join(f.folder, "private.txt"), "utf8"),
    "private local work\n",
  );

  const nested = await fixture(t);
  await mkdir(join(nested.folder, "cache"));
  await writeFile(join(nested.folder, ".gitignore"), "cache/private.txt\n");
  await writeFile(join(nested.folder, "cache/tracked.txt"), "bot feature\n");
  await git(nested.folder, "add", ".");
  await git(nested.folder, "commit", "-m", "partly tracked directory");
  await writeFile(
    join(nested.folder, "cache/private.txt"),
    "nested local work\n",
  );
  await nested.update("cache", "upstream replaces directory with file\n");
  assert.equal(
    (await synchronizeWorktree(nested.folder, branch)).reason,
    "dirty",
  );
  assert.equal(
    await readFile(join(nested.folder, "cache/private.txt"), "utf8"),
    "nested local work\n",
  );
});

test("failed fetch, checkout mismatch and an active agent never change HEAD", async (t) => {
  const f = await fixture(t);
  const head = await git(f.folder, "rev-parse", "HEAD");
  await f.update();
  assert.equal(
    (await synchronizeWorktree(f.folder, "wrong-branch")).reason,
    "checkout_mismatch",
  );
  let checked = false;
  assert.equal(
    (
      await synchronizeWorktree(f.folder, branch, undefined, async () => {
        checked = true;
        return false;
      })
    ).reason,
    "busy",
  );
  assert.equal(checked, true);
  assert.equal(await git(f.folder, "rev-parse", "HEAD"), head);
  await git(
    f.repo,
    "remote",
    "set-url",
    "origin",
    "/nonexistent/private-secret-path",
  );
  const result = await synchronizeWorktree(f.folder, branch);
  assert.equal(result.reason, "fetch_failed");
  assert.equal(result.state, "blocked");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(await git(f.folder, "rev-parse", "HEAD"), head);
  await git(f.folder, "checkout", "--detach", head);
  assert.equal(
    (await synchronizeWorktree(f.folder, branch)).reason,
    "checkout_mismatch",
  );
});
