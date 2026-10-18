import { Text, View } from "react-native";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import type { Choices } from "../shared/contracts.ts";
import type { Profile, Target } from "../shared/config.ts";
import { Field } from "./controls.tsx";

export const blankProfile = (): Profile => ({ kind: "custom", provider: "", systemPrompt: "" });
export function RouteEditor({ theme, target, onChange, choices }: { theme: PluginTheme; target: Target | null; onChange(target: Target | null): void; choices: Choices }) {
  const c = theme.colors;
  const custom = target?.kind === "workspace" && target.profile.kind === "custom" ? target.profile : null;
  const provider = custom?.provider.split("/")[0] ?? "";
  const model = custom?.provider.slice(provider.length + 1) ?? "";
  const selectedProvider = choices.providers.find(value => value.id === provider);
  const profile = (value: Profile) => { if (target?.kind === "workspace") onChange({ ...target, profile: value }); };
  return <View style={{ gap: 18 }}>
    <SettingsSelect label="Send Telegram messages to" value={target?.kind ?? "none"} options={[{ value: "none", label: "Choose a destination" }, { value: "agent", label: "An existing Paseo chat" }, { value: "workspace", label: "Separate chats in a workspace" }]} onValueChange={value => onChange(value === "agent" ? { kind: "agent", agentId: "", sharedHistory: false } : value === "workspace" ? { kind: "workspace", workspaceId: "", profile: blankProfile(), git: null } : null)} />
    {target?.kind === "agent" && <>
      <SettingsSelect label="Paseo chat" hint="Keeps the same agent, history, model and permissions." value={target.agentId} options={[{ value: "", label: "Choose a chat" }, ...choices.agents.map(value => ({ value: value.id, label: value.title }))]} onValueChange={agentId => onChange({ ...target, agentId })} />
      <SettingsSwitch label="Share this history across Telegram conversations" hint="Off by default. Enable only when different groups or topics should use the same Paseo chat." value={target.sharedHistory} onValueChange={sharedHistory => onChange({ ...target, sharedHistory })} />
    </>}
    {target?.kind === "workspace" && <>
      <SettingsSelect label="Workspace" hint="Each Telegram chat or topic gets its own agent and history here." value={target.workspaceId} options={[{ value: "", label: "Choose a workspace" }, ...choices.workspaces.map(value => ({ value: value.id, label: `${value.project} · ${value.title}` }))]} onValueChange={workspaceId => onChange({ ...target, workspaceId })} />
      <SettingsSelect label="Settings for new agents" value={target.profile.kind} options={[{ value: "custom", label: "Ordinary Paseo settings" }, ...(choices.botsAvailable ? [{ value: "bots", label: "A Bots profile" }] : [])]} onValueChange={value => profile(value === "bots" ? { kind: "bots", botId: "" } : blankProfile())} />
      {target.profile.kind === "bots" && <SettingsSelect label="Bots profile" value={target.profile.botId} options={[{ value: "", label: "Choose a profile" }, ...choices.bots.map(value => ({ value: value.id, label: value.name }))]} onValueChange={botId => profile({ kind: "bots", botId })} />}
      {custom && <>
        <SettingsSelect label="Provider" value={provider} options={[{ value: "", label: "Choose a provider" }, ...choices.providers.map(value => ({ value: value.id, label: value.label }))]} onValueChange={value => profile({ ...custom, provider: `${value}/`, modeId: undefined, thinkingOptionId: undefined })} />
        {!!provider && <SettingsSelect label="Model" value={model} options={[{ value: "", label: "Choose a model" }, ...(selectedProvider?.models ?? []).map(value => ({ value: value.id, label: value.label }))]} onValueChange={value => profile({ ...custom, provider: `${provider}/${value}`, thinkingOptionId: undefined })} />}
        {!!provider && <SettingsSelect label="Permissions" value={custom.modeId ?? ""} options={[{ value: "", label: "Provider default" }, ...(selectedProvider?.modes ?? []).map(value => ({ value: value.id, label: value.label }))]} onValueChange={value => profile({ ...custom, modeId: value || undefined })} />}
        {!!selectedProvider?.models.find(value => value.id === model)?.thinking.length && <SettingsSelect label="Thinking effort" value={custom.thinkingOptionId ?? ""} options={[{ value: "", label: "Model default" }, ...(selectedProvider?.models.find(value => value.id === model)?.thinking ?? []).map(value => ({ value: value.id, label: value.label }))]} onValueChange={value => profile({ ...custom, thinkingOptionId: value || undefined })} />}
        <Field theme={theme} label="Instructions" value={custom.systemPrompt} onChange={systemPrompt => profile({ ...custom, systemPrompt })} multiline placeholder="What should this agent help with?" hint="Uses your existing Paseo providers and subscriptions. No separate model API key is required by this connector." />
      </>}
      <SettingsSwitch label="A Git worktree for each conversation" hint="Creates a separate workspace and branch in the same project. Existing chats and their folders are kept." value={!!target.git} onValueChange={enabled => onChange({ ...target, git: enabled ? { remote: "origin", branch: "main" } : null })} />
      {target.git && <View style={{ gap: 16 }}>
        <Field theme={theme} label="Git remote" value={target.git.remote} onChange={remote => onChange({ ...target, git: { ...target.git!, remote } })} />
        <Field theme={theme} label="Upstream branch" value={target.git.branch} onChange={branch => onChange({ ...target, git: { ...target.git!, branch } })} hint="Fetches before each new request. Preserves local changes and committed work; conflicts are left for the agent to reconcile." />
      </View>}
      <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>Profile changes apply to newly created chats. Existing chats keep their agent settings.</Text>
    </>}
  </View>;
}
