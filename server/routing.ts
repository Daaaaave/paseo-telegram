import { UserFacingError } from "./errors.ts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { Connection, Target } from "../shared/config.ts";
import { CONNECTION_LABEL, CONVERSATION_LABEL } from "../shared/config.ts";
import { conversationKey, type TelegramMessage } from "../shared/telegram.ts";
import type { Store, Job, State } from "./store.ts";
import { BotsAdapter } from "./bots.ts";
import { synchronizeWorktree, syncContext, syncBlockedReply } from "./sync.ts";
import { waitForTask } from "./questions.ts";

const run = promisify(execFile);
export function isCurrentRoute(
  config: Connection,
  state: State,
  conversation: State["conversations"][string],
): boolean {
  const [canonical, topic] = conversation.key.split(":");
  const actual =
    Object.keys(state.aliases).find(
      (key) => state.aliases[key] === canonical,
    ) ?? canonical;
  const target =
    config.bindings[`${actual}:${topic}`] ??
    config.bindings[conversation.key] ??
    config.bindings[`${actual}:0`] ??
    config.bindings[`${canonical}:0`] ??
    config.target;
  return (
    !!target &&
    routeIdentity(config.id, conversation.key, target).key ===
      conversation.routeKey
  );
}
export function routeIdentity(
  connectionId: string,
  key: string,
  target: Target,
): { key: string; slug: string; agentId: string } {
  const identity =
    target.kind === "agent"
      ? `agent:${target.agentId}`
      : `workspace:${target.workspaceId}:${target.profile.kind === "bots" ? target.profile.botId : "custom"}:${JSON.stringify(target.git)}`;
  const hash = createHash("sha256")
    .update(`${connectionId}:${key}:${identity}`)
    .digest("hex");
  return {
    key: hash,
    slug: hash.slice(0, 20),
    agentId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
  };
}

/** Serializes shared existing-agent bindings across every connected bot. */
export class AgentQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.queues.set(key, task);
    void task
      .finally(() => {
        if (this.queues.get(key) === task) this.queues.delete(key);
      })
      .catch(() => {});
    return task;
  }
}

export class Router {
  readonly api: PaseoApi;
  private readonly bots: BotsAdapter;
  private readonly store: Store;
  private readonly connection: () => Connection;
  private readonly canBind: (agentId: string, key: string) => boolean;
  constructor(
    api: PaseoApi,
    bots: BotsAdapter,
    store: Store,
    connection: () => Connection,
    canBind: (agentId: string, key: string) => boolean = () => true,
  ) {
    this.api = api;
    this.bots = bots;
    this.store = store;
    this.connection = connection;
    this.canBind = canBind;
  }
  key(message: TelegramMessage): string {
    return `${this.store.state.aliases[String(message.chat.id)] ?? message.chat.id}:${message.message_thread_id ?? 0}`;
  }
  target(message: TelegramMessage): Target | null {
    const config = this.connection();
    const key = this.key(message);
    const current = conversationKey(message);
    return (
      config.bindings[current] ??
      config.bindings[key] ??
      config.bindings[`${message.chat.id}:0`] ??
      config.bindings[`${key.split(":")[0]}:0`] ??
      config.target
    );
  }
  queueKey(message: TelegramMessage, job: Job): string {
    const target = job.route ?? this.target(message);
    if (job.agentId) return `agent:${job.agentId}`;
    if (!target) return `${this.connection().id}:${this.key(message)}`;
    const identity = routeIdentity(
      this.connection().id,
      this.key(message),
      target,
    );
    return `agent:${target.kind === "agent" ? target.agentId : (this.store.state.agents[identity.key] ?? identity.agentId)}`;
  }
  async prepare(
    message: TelegramMessage,
    job: Job,
    signal?: AbortSignal,
  ): Promise<{ id: string; context: string }> {
    const state = this.store.state;
    if (job.agentId)
      return {
        id: job.agentId,
        context: job.sync ? syncContext(job.sync) : "",
      };
    const connection = this.connection();
    const key = this.key(message);
    const target = job.route ?? this.target(message);
    if (!target)
      throw new UserFacingError(
        "Setup incomplete. Open Paseo → Telegram, choose a chat or workspace and select Save settings before requesting agent replies.",
      );
    job.route = structuredClone(target);
    const identity = routeIdentity(connection.id, key, target);
    job.routeKey = identity.key;
    let id = state.agents[identity.key];
    if (target.kind === "agent") {
      if (
        !target.sharedHistory &&
        (!this.canBind(target.agentId, key) ||
          Object.values(state.conversations).some(
            (value) =>
              value.agentId === target.agentId &&
              value.key !== key &&
              isCurrentRoute(connection, state, value),
          ))
      )
        throw new UserFacingError(
          "This Paseo chat is already bound to another Telegram conversation. Enable shared history explicitly or choose a different chat.",
        );
      id = target.agentId;
      const snapshot = await this.api.agents.ref(id).refresh();
      if (
        !snapshot ||
        snapshot.agent.archivedAt ||
        snapshot.agent.status === "closed"
      )
        throw new UserFacingError("The linked Paseo chat is unavailable");
      state.conversations[identity.key] = {
        key,
        title: message.chat.title ?? "Direct messages",
        agentId: id,
        workspaceId: snapshot.agent.workspaceId ?? undefined,
        routeKey: identity.key,
      };
    } else if (!id) {
      const base = this.api.workspaces.ref(target.workspaceId);
      const source = await base.refresh();
      if (!source || source.archivingAt)
        throw new UserFacingError("The selected workspace is unavailable");
      let workspace = base;
      let branch: string | undefined;
      if (target.git) {
        await run(
          "git",
          [
            "-C",
            source.workspaceDirectory,
            "check-ref-format",
            "--branch",
            target.git.branch,
          ],
          { signal, timeout: 5000 },
        ).catch(() => {
          throw new UserFacingError("The upstream branch name is invalid.");
        });
        await run(
          "git",
          [
            "-C",
            source.workspaceDirectory,
            "fetch",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            target.git.remote,
            `+refs/heads/${target.git.branch}:refs/remotes/${target.git.remote}/${target.git.branch}`,
          ],
          {
            signal,
            timeout: 45_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        ).catch(() => {
          throw new UserFacingError(
            "Could not fetch the upstream branch. Check Git access in Paseo before retrying.",
          );
        });
        branch = `telegram/${identity.slug}`;
        workspace = await this.api.workspaces.create({
          title: `Telegram · ${message.chat.title ?? "Direct messages"}`,
          source: {
            kind: "worktree",
            cwd: source.workspaceDirectory,
            projectId: source.projectId,
            action: "branch-off",
            baseBranch: `${target.git.remote}/${target.git.branch}`,
            branchName: branch,
            worktreeSlug: `telegram-${identity.slug}`,
          },
          idempotencyKey: `telegram-workspace-${identity.key}`,
        });
      }
      const profile =
        target.profile.kind === "bots"
          ? await this.bots.config(
              target.profile.botId,
              identity.agentId,
              message.text ?? "",
              this.api,
            )
          : {
              labels: {},
              config: {
                provider: target.profile.provider,
                ...(target.profile.modeId
                  ? { modeId: target.profile.modeId }
                  : {}),
                ...(target.profile.thinkingOptionId
                  ? { thinkingOptionId: target.profile.thinkingOptionId }
                  : {}),
                systemPrompt: target.profile.systemPrompt,
              },
            };
      const agent = await workspace.agents.create({
        agentId: identity.agentId,
        idempotencyKey: `telegram-agent-${identity.key}`,
        config: profile.config,
        labels: {
          ...profile.labels,
          [CONNECTION_LABEL]: connection.id,
          [CONVERSATION_LABEL]: key,
        },
        title: `Telegram · ${message.chat.title ?? "Direct messages"}${message.message_thread_id ? ` · ${message.message_thread_id}` : ""}`,
      });
      id = agent.id;
      state.conversations[identity.key] = {
        key,
        title: message.chat.title ?? "Direct messages",
        agentId: id,
        workspaceId: workspace.id,
        routeKey: identity.key,
        ...(target.git
          ? { folder: workspace.directory ?? undefined, branch }
          : {}),
      };
    }
    if (!id) throw new UserFacingError("Cannot resolve the Paseo conversation");
    signal?.throwIfAborted();
    state.agents[identity.key] = id;
    job.agentId = id;
    await this.store.save();
    let context = "";
    if (target.kind === "workspace" && target.git) {
      const checkout = state.conversations[identity.key];
      if (!checkout?.folder || !checkout.branch)
        throw new UserFacingError("The linked Git worktree is unavailable");
      const current = await this.api.agents.ref(id).refresh();
      if (
        current?.agent.activeTurn ||
        current?.agent.status === "running" ||
        current?.agent.status === "initializing"
      ) {
        const result = await waitForTask(
          this.api.agents.ref(id),
          signal ?? new AbortController().signal,
        );
        if (result.status !== "idle")
          throw new UserFacingError(
            "The agent needs attention in Paseo before its worktree can be synchronized.",
          );
      }
      const isIdle = async () => {
        const snapshot = await this.api.agents.ref(id!).refresh();
        return (
          !!snapshot &&
          snapshot.agent.cwd === checkout.folder &&
          snapshot.agent.status === "idle" &&
          !snapshot.agent.activeTurn
        );
      };
      job.sync = await synchronizeWorktree(
        checkout.folder,
        checkout.branch,
        signal,
        isIdle,
        target.git,
      );
      await this.store.save();
      if (job.sync.state === "blocked")
        throw new UserFacingError(syncBlockedReply(job.sync.reason));
      context = syncContext(job.sync);
    }
    return { id, context };
  }
}
