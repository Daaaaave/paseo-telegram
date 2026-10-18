import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { Connection } from "../shared/config.ts";
import { connectionSchema } from "../shared/config.ts";
import type { Choices, ConnectionView } from "../shared/contracts.ts";
import { Registry } from "./registry.ts";
import { Store } from "./store.ts";
import { Bridge } from "./bridge.ts";
import { Telegram, pause } from "./telegram.ts";
import { Router, AgentQueue, isCurrentRoute } from "./routing.ts";
import { BotsAdapter } from "./bots.ts";
import { connectLocalDaemon, type DaemonConnection } from "./daemon.ts";
import { collectPages } from "./pages.ts";

export class Manager {
  readonly registry: Registry;
  readonly bridges = new Map<string, Bridge>();
  private readonly stores = new Map<string, Store>();
  private readonly errors = new Map<string, string>();
  private readonly queue = new AgentQueue();
  private readonly controller = new AbortController();
  private daemon: DaemonConnection | null = null;
  private loading: Promise<void>;
  private changes: Promise<unknown> = Promise.resolve();
  error: string | null = null;
  private readonly root: string; private readonly home: string; private readonly connect: typeof connectLocalDaemon;
  constructor(root: string, home: string, connect = connectLocalDaemon) {
    this.root = root; this.home = home; this.connect = connect;
    this.registry = new Registry(root);
    this.loading = this.registry.load().catch(() => { this.error = "Telegram settings could not be loaded. Restore the saved configuration before continuing."; throw new Error(this.error); });
    void this.loading.catch(() => {});
  }
  start(): void { void this.run().catch(() => { if (!this.controller.signal.aborted) this.error = "Telegram startup failed. Inspect the plugin’s configuration."; }); }
  private async run(): Promise<void> {
    await this.loading;
    while (!this.controller.signal.aborted) {
      try {
        this.daemon = await this.connect(this.home);
        if (this.controller.signal.aborted) { await this.daemon.close(); this.daemon = null; return; }
        this.error = null;
        for (const config of this.registry.connections) { try { await this.store(config.id); } catch { this.errors.set(config.id, "Saved conversation state is invalid; restore it before continuing."); } }
        for (const config of this.registry.connections) await this.activate(config);
        return;
      } catch { this.error = "Waiting for the local Paseo daemon; reconnecting automatically."; await pause(5000, this.controller.signal); }
    }
  }
  private async requireDaemon(): Promise<DaemonConnection> {
    await this.loading;
    if (!this.daemon) throw new Error("Paseo is connecting. Try again in a moment.");
    return this.daemon;
  }
  private async store(id: string): Promise<Store> {
    let store = this.stores.get(id);
    if (!store) { store = new Store(join(this.root, "connections", id)); await store.load(); this.stores.set(id, store); }
    return store;
  }
  private async activate(config: Connection): Promise<void> {
    if (!this.daemon || this.controller.signal.aborted) return;
    await this.bridges.get(config.id)?.stop(); this.bridges.delete(config.id);
    try {
      const store = await this.store(config.id);
      if (!config.enabled) return;
      const telegram = new Telegram(() => this.registry.token(config.id));
      const router = new Router(this.daemon.api, new BotsAdapter(this.daemon.invoke, this.daemon.serverId), store, () => this.registry.get(config.id), (agentId, key) => {
        if (this.errors.size) return false;
        for (const [connectionId, state] of this.stores) {
          const current = this.registry.connections.find(value => value.id === connectionId);
          if (current && Object.values(state.state.conversations).some(value => value.agentId === agentId && (connectionId !== config.id || value.key !== key) && isCurrentRoute(current, state.state, value))) return false;
        }
        return true;
      });
      const bridge = new Bridge(telegram, store, router, () => this.registry.get(config.id), this.queue);
      this.bridges.set(config.id, bridge); this.errors.delete(config.id); bridge.start();
    } catch { this.errors.set(config.id, "This connection’s saved state is invalid. Restore it before enabling the receiver."); }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.changes.then(operation);
    this.changes = task.catch(() => {}); return task;
  }
  async list(): Promise<{ connections: ConnectionView[]; daemonConnected: boolean; error: string | null }> {
    try { await this.loading; } catch { return { connections: [], daemonConnected: false, error: this.error }; }
    const connections: ConnectionView[] = [];
    for (const config of this.registry.connections) {
      let store: Store | undefined;
      try { store = await this.store(config.id); } catch { this.errors.set(config.id, "Saved conversation state is invalid; restore it before continuing."); }
      const bridge = this.bridges.get(config.id);
      connections.push({ config, ownerId: store?.state.ownerId ?? null, running: bridge?.running ?? false, lastError: this.errors.get(config.id) ?? bridge?.lastError ?? null, queued: bridge?.queued ?? 0,
        groups: Object.entries(store?.state.groups ?? {}).map(([id, group]) => ({ id, title: group.title })),
        conversations: Object.values(store?.state.conversations ?? {}).map(value => ({ key: value.key, title: value.title, agentId: value.agentId, workspaceId: value.workspaceId, current: !!store && isCurrentRoute(config, store.state, value), active: Object.values(store?.state.jobs ?? {}).some(job => job.agentId === value.agentId && !job.delivery) })),
      });
    }
    return { connections, daemonConnected: !!this.daemon, error: this.error };
  }
  add(input: { name: string; token: string }): Promise<{ id: string; username: string }> {
    return this.exclusive(async () => {
      await this.requireDaemon();
      const telegram = new Telegram(async () => input.token);
      const identity = await telegram.call<{ id: number; username: string; is_bot: boolean }>("getMe", {}, this.controller.signal);
      if (!identity.is_bot || !identity.username) throw new Error("Telegram did not return a bot account");
      const webhook = await telegram.call<{ url: string }>("getWebhookInfo", {}, this.controller.signal);
      if (webhook.url) throw new Error("This bot has an active webhook. Disconnect its other integration first; Paseo will not replace it.");
      const config = await this.registry.add(input.name, input.token, identity);
      await this.activate(config); return { id: config.id, username: config.username };
    });
  }
  save(input: Pick<Connection, "id" | "name" | "enabled" | "target" | "policy" | "bindings" | "revision">): Promise<Connection> {
    return this.exclusive(async () => {
      await this.loading;
      const daemon = input.enabled ? await this.requireDaemon() : null;
      const current = this.registry.get(input.id);
      const config = connectionSchema.parse({ ...current, ...input });
      for (const target of config.enabled ? [config.target, ...Object.values(config.bindings)] : []) {
        if (!target) continue;
        if (target.kind === "agent") {
          const snapshot = await daemon!.api.agents.ref(target.agentId).refresh();
          if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.status === "closed") throw new Error("The selected chat is unavailable. Refresh the list and choose another chat.");
        } else {
          const workspace = await daemon!.api.workspaces.ref(target.workspaceId).refresh();
          if (!workspace || workspace.archivingAt) throw new Error("The selected workspace is unavailable.");
          if (target.profile.kind === "bots") {
            const botId = target.profile.botId;
            const choices = await new BotsAdapter(daemon!.invoke, daemon!.serverId).choices();
            if (!choices.bots.some(bot => bot.id === botId)) throw new Error("The selected Bots profile is unavailable on this host.");
          }
        }
      }
      const updated = await this.registry.update(config);
      const bridge = this.bridges.get(config.id);
      if (config.enabled && (!bridge || !bridge.running)) await this.activate(updated);
      if (!config.enabled) { await bridge?.stop(); this.bridges.delete(config.id); }
      return updated;
    });
  }
  pair(id: string): Promise<{ url: string; expiresAt: number }> {
    return this.exclusive(async () => {
      await this.loading;
      const config = this.registry.get(id), store = await this.store(id);
      if (store.state.ownerId !== null) throw new Error("This bot already has a paired owner");
      const nonce = randomBytes(16).toString("hex"), expiresAt = Date.now() + 30 * 60_000;
      store.state.pairing = { hash: createHash("sha256").update(nonce).digest("hex"), expiresAt };
      await store.save();
      return { url: `https://t.me/${config.username}?start=owner_${nonce}`, expiresAt };
    });
  }
  disconnect(id: string): Promise<{ removed: boolean }> {
    return this.exclusive(async () => {
      await this.loading;
      const bridge = this.bridges.get(id); await bridge?.stop(); this.bridges.delete(id);
      await this.registry.remove(id); this.stores.delete(id); this.errors.delete(id);
      return { removed: true };
    });
  }
  revoke(id: string, chatId: string): Promise<{ revoked: boolean }> {
    return this.exclusive(async () => {
      this.registry.get(id);
      const store = await this.store(id); delete store.state.groups[chatId]; delete store.state.pendingGroups[chatId]; await store.save();
      return { revoked: true };
    });
  }
  async choices(): Promise<Choices> {
    const daemon = await this.requireDaemon();
    const [agents, workspaces, providers, bots] = await Promise.all([
      collectPages(cursor => daemon.api.agents.list({ filter: { includeArchived: false }, page: { limit: 200, cursor } })), collectPages(cursor => daemon.api.workspaces.list({ page: { limit: 200, cursor } })), daemon.api.providers.snapshot(), new BotsAdapter(daemon.invoke, daemon.serverId).choices(),
    ]);
    return { agents: agents.entries.filter(({ agent }) => !agent.archivedAt && agent.status !== "closed").map(({ agent }) => ({ id: agent.id, title: agent.title || "Untitled chat", workspaceId: agent.workspaceId ?? null })),
      workspaces: workspaces.entries.filter(value => !value.archivingAt).map(value => ({ id: value.id, title: value.title || value.name, directory: value.workspaceDirectory, project: value.projectDisplayName })),
      providers: providers.entries.filter(value => value.enabled !== false).map(value => ({ id: value.provider, label: value.label || value.provider, models: (value.models ?? []).filter(model => model.isSelectable !== false).map(model => ({ id: model.id, label: model.label, thinking: (model.thinkingOptions ?? []).map(option => ({ id: option.id, label: option.label })) })), modes: (value.modes ?? []).map(mode => ({ id: mode.id, label: mode.label })) })), ...bots };
  }
  async onAgentCreated(id: string, api: PaseoApi): Promise<void> {
    const snapshot = await api.agents.ref(id).refresh();
    const previous = snapshot?.agent.labels?.["zerosub.continued-from"];
    if (previous) for (const bridge of this.bridges.values()) await bridge.followContinuation(previous, id);
  }
  async onPermissionResolved(agentId: string, requestId: string): Promise<void> {
    for (const store of this.stores.values()) {
      let changed = false;
      for (const job of Object.values(store.state.jobs)) if (job.agentId === agentId && job.question?.requestId === requestId) { job.question.status = "answered"; changed = true; }
      if (changed) await store.save();
    }
  }
  async stop(): Promise<void> {
    this.controller.abort(); await Promise.allSettled([...this.bridges.values()].map(bridge => bridge.stop())); this.bridges.clear();
    await this.daemon?.close(); this.daemon = null;
  }
}
