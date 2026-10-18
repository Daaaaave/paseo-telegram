import type { GitSettings } from "../shared/config.ts";
import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const queues = new Map<string, Promise<unknown>>();
export interface SyncReport {
  state: "ready" | "attention" | "blocked";
  reason: "current" | "fast_forward" | "merge" | "dirty" | "operation" | "conflict" | "fetch_failed" | "checkout_mismatch" | "git_failed" | "busy";
  checkedAt: number;
  upstream?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  reconciled?: boolean;
}

async function git(folder: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await run("git", ["-C", folder, ...args], {
    signal, timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
  });
  return result.stdout.replace(/\n$/, "");
}

async function operationPending(folder: string, signal?: AbortSignal): Promise<boolean> {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"]) {
    const path = await git(folder, ["rev-parse", "--git-path", name], signal);
    try { await access(resolve(folder, path)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return false;
}

async function matchesCheckout(folder: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  if (await realpath(folder) !== await realpath(await git(folder, ["rev-parse", "--show-toplevel"], signal))) return false;
  try { return await git(folder, ["symbolic-ref", "--quiet", "HEAD"], signal) === `refs/heads/${branch}`; }
  catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
}

/** Fetch and integrate only between turns. Never stash, reset, rebase or force-push. */
export async function synchronizeWorktree(folder: string, branch: string, signal?: AbortSignal, isIdle: () => Promise<boolean> = async () => true, upstream: GitSettings = { remote: "origin", branch: "main" }): Promise<SyncReport> {
  const report: SyncReport = { state: "blocked", reason: "git_failed", checkedAt: Date.now() };
  let common: string;
  try { common = await realpath(resolve(folder, await git(folder, ["rev-parse", "--git-common-dir"], signal))); }
  catch { signal?.throwIfAborted(); return report; }
  // Linked worktrees share remote refs. Pin the fetched SHA inside this queue;
  // another conversation fetching later cannot change this turn's target.
  const previous = queues.get(common) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async (): Promise<SyncReport> => {
    signal?.throwIfAborted();
    try {
      if (!await matchesCheckout(folder, branch, signal)) return { ...report, reason: "checkout_mismatch" };
      try {
        await git(folder, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", upstream.remote, `+refs/heads/${upstream.branch}:refs/remotes/${upstream.remote}/${upstream.branch}`], signal);
      } catch { signal?.throwIfAborted(); return { ...report, reason: "fetch_failed" }; }
      report.upstream = await git(folder, ["rev-parse", "--verify", `refs/remotes/${upstream.remote}/${upstream.branch}^{commit}`], signal);
      report.head = await git(folder, ["rev-parse", "HEAD"], signal);
      [report.ahead, report.behind] = (await git(folder, ["rev-list", "--left-right", "--count", `HEAD...${report.upstream}`], signal)).split(/\s+/).map(Number);
      if (!await isIdle()) return { ...report, reason: "busy" };
      if (!await matchesCheckout(folder, branch, signal)) return { ...report, reason: "checkout_mismatch" };
      if (await operationPending(folder, signal)) return { ...report, state: "attention", reason: "operation" };
      // Include staged files and untracked files, including those colliding with upstream.
      if (await git(folder, ["status", "--porcelain=v1", "--untracked-files=normal"], signal)) return { ...report, state: "attention", reason: "dirty" };
      if (!report.behind) return { ...report, state: "ready", reason: "current" };
      // merge-ort can overwrite ignored files even with --no-overwrite-ignore.
      // Collapse ignored directories to avoid enumerating installed dependencies.
      const ignored = (await git(folder, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], signal)).split("\0").filter(Boolean);
      if (ignored.length) {
        const incoming = (await git(folder, ["diff", "--name-only", "--diff-filter=A", "--no-renames", "-z", "HEAD", report.upstream], signal)).split("\0").filter(Boolean);
        if (incoming.some(path => ignored.some(local => {
          const name = local.replace(/\/$/, "");
          return name === path || path.startsWith(`${name}/`) || name.startsWith(`${path}/`);
        }))) {
          return { ...report, state: "attention", reason: "dirty" };
        }
      }
      try {
        await git(folder, ["-c", "user.name=Paseo Telegram", "-c", "user.email=paseo-telegram@localhost", "-c", "merge.autoStash=false", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "merge", ...(report.ahead ? ["--no-edit", "--commit", "--ff"] : ["--ff-only"]), "--no-stat", "--no-overwrite-ignore", report.upstream], signal);
      } catch {
        signal?.throwIfAborted();
        // Leave the index/conflicts intact for the same agent to reconcile.
        return { ...report, state: "attention", reason: await operationPending(folder, signal) ? "conflict" : "git_failed" };
      }
      report.head = await git(folder, ["rev-parse", "HEAD"], signal);
      return { ...report, state: "ready", reason: report.ahead ? "merge" : "fast_forward" };
    } catch { signal?.throwIfAborted(); return report; }
  });
  queues.set(common, task);
  try { return await task; }
  finally { if (queues.get(common) === task) queues.delete(common); }
}

/** Verify reconciliation against this turn's pinned target, without fetching mid-turn. */
export async function syncIsComplete(folder: string, branch: string, upstream: string, signal?: AbortSignal): Promise<boolean> {
  try {
    if (!await matchesCheckout(folder, branch, signal) || await operationPending(folder, signal)) return false;
    await git(folder, ["merge-base", "--is-ancestor", upstream, "HEAD"], signal);
    return !(await git(folder, ["diff", "--name-only", "--diff-filter=U"], signal));
  } catch { signal?.throwIfAborted(); return false; }
}

export function syncContext(report: SyncReport): string {
  return [
    "Connector Git synchronization before this new request (not part of the participant's message):",
    JSON.stringify(report),
    "The target is the freshly fetched upstream commit above. Do not rely on earlier conversation claims about code without rereading relevant files.",
    report.state === "attention"
      ? "FIRST reconcile this worktree with that exact upstream commit, preserving staged, unstaged, untracked and committed work. Inspect status and any operation already in progress. Resolve conflicts deliberately; do not discard, blindly stash, rebase or rewrite shared history. Then handle the participant's request. If reconciliation cannot be completed safely, explicitly report the blocker and do not present stale code as current or deploy it."
      : "This worktree includes that upstream commit. Preserve local feature work and follow the repository's normal release checks before any requested deployment.",
  ].join("\n");
}

export function syncBlockedReply(reason?: SyncReport["reason"]): string {
  const detail = reason === "fetch_failed" ? "Could not fetch the upstream branch."
    : reason === "checkout_mismatch" ? "The worktree no longer matches this conversation’s branch."
    : reason === "busy" ? "The agent is still working, or its folder changed."
    : "Could not check and synchronize the conversation’s worktree.";
  return `${detail} The request was not started. Check its Paseo chat before retrying.`;
}

export const syncIncompleteReply = "⚠️ The worktree is not yet synchronized with upstream. The answer may use older code; changes are not ready for deployment.";
