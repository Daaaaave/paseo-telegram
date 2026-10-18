import { UserFacingError } from "./errors.ts";
import { z } from "zod";
import type { PaseoAgentConfig, PaseoApi } from "@getpaseo/client";
import type { PluginInvoker } from "./daemon.ts";
import { BOT_LABEL } from "../shared/config.ts";

const mcpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio"), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.enum(["http", "sse"]), url: z.string(), headers: z.record(z.string(), z.string()).optional() }),
]);
const botSchema = z.object({ id: z.string(), name: z.string(), provider: z.string(), model: z.string().nullable(), modeId: z.string().nullable(), thinkingOptionId: z.string().nullable(), hostId: z.string().nullable(), archived: z.boolean(), mcpServerIds: z.array(z.string()).default([]), alwaysAllow: z.array(z.string()).default([]) }).passthrough();
const valuesSchema = z.object({ bots: z.array(botSchema), library: z.object({ mcpServers: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean(), config: mcpSchema })) }).optional() });
export class BotsAdapter {
  private readonly invoke: PluginInvoker;
  private readonly serverId: string | null;
  constructor(invoke: PluginInvoker, serverId: string | null) { this.invoke = invoke; this.serverId = serverId; }
  private async read() {
    const state = z.object({ status: z.literal("ready"), values: valuesSchema }).parse(await this.invoke("paseo-bots", "settings.bots.read", {}));
    return state.values;
  }
  async choices(): Promise<{ bots: { id: string; name: string }[]; botsAvailable: boolean; botsError: string | null }> {
    try {
      const values = await this.read();
      return { bots: values.bots.filter(bot => !bot.archived && (!bot.hostId || bot.hostId === this.serverId)).map(bot => ({ id: bot.id, name: bot.name })), botsAvailable: true, botsError: null };
    } catch { return { bots: [], botsAvailable: false, botsError: "Bots is unavailable on this host. Ordinary Paseo chats work without it." }; }
  }
  async config(botId: string, agentId: string, message: string, api: PaseoApi): Promise<{ config: PaseoAgentConfig; labels: Record<string, string> }> {
    const values = await this.read().catch(() => { throw new UserFacingError("The selected Bots profile is unavailable"); });
    const bot = values.bots.find(bot => bot.id === botId && !bot.archived);
    if (!bot || (bot.hostId && bot.hostId !== this.serverId)) throw new UserFacingError("The selected Bots profile is not available on this host");
    let model = bot.model;
    if (!model) {
      const snapshot = await api.providers.snapshot();
      const models = snapshot.entries.find(entry => entry.provider === bot.provider)?.models?.filter(value => value.isSelectable !== false) ?? [];
      model = (models.find(value => value.isDefault) ?? models[0])?.id ?? null;
    }
    if (!model) throw new UserFacingError("Choose a model in the Bots profile before connecting it");
    await this.invoke("paseo-bots", "bots.hello", {});
    const prompt = z.object({ systemPrompt: z.string() }).parse(await this.invoke("paseo-bots", "bots.system-prompt", { bot, local: true, message }));
    const mounted = z.object({ tools: mcpSchema, apps: mcpSchema.nullable() }).parse(await this.invoke("paseo-bots", "bots.mount", { botId, agentId }));
    const mcpServers: NonNullable<PaseoAgentConfig["mcpServers"]> = {};
    for (const entry of values.library?.mcpServers ?? []) {
      if (entry.enabled && bot.mcpServerIds.includes(entry.id) && /^[A-Za-z0-9_-]{1,64}$/.test(entry.name) && !["paseo", "bots", "composio"].includes(entry.name)) mcpServers[entry.name] = entry.config;
    }
    mcpServers.bots = mounted.tools;
    if (mounted.apps) mcpServers.composio = mounted.apps;
    const preapproved = /^(claude|codex|opencode)(\b|$)/.test(bot.provider) ? bot.alwaysAllow.flatMap(value => {
      const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
      return match && mcpServers[match[1]] ? [{ kind: "mcp" as const, server: match[1], tool: match[2] }] : [];
    }) : [];
    return { labels: { [BOT_LABEL]: bot.id }, config: { provider: `${bot.provider}/${model}`, ...(bot.modeId ? { modeId: bot.modeId } : {}), ...(bot.thinkingOptionId ? { thinkingOptionId: bot.thinkingOptionId } : {}), systemPrompt: prompt.systemPrompt, mcpServers, ...(preapproved.length ? { toolPolicy: { preapproved } } : {}) } };
  }
}
