import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ScrollView,
  Icon,
  copyText,
} from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type {
  PluginClientContext,
  PluginScreenProps,
} from "@getpaseo/plugin/client";
import {
  addRpc,
  choicesRpc,
  disconnectRpc,
  listRpc,
  pairRpc,
  revokeRpc,
  saveRpc,
  type Choices,
  type ConnectionView,
} from "../shared/contracts.ts";
import {
  connectionSchema,
  type Connection,
  type Target,
} from "../shared/config.ts";
import { Button, Field, Notice, errorText } from "./controls.tsx";
import { RouteEditor } from "./route-editor.tsx";

const EMPTY_CHOICES: Choices = {
  agents: [],
  workspaces: [],
  providers: [],
  bots: [],
  botsAvailable: false,
  botsError: null,
};
type Client = Pick<PluginClientContext, "rpc">;
export function TelegramScreen({
  client,
  ...props
}: PluginScreenProps & { client: Client }) {
  const { theme, layout } = props,
    c = theme.colors;
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [choices, setChoices] = useState<Choices>(EMPTY_CHOICES);
  const choicesReady = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(
    async (includeChoices = false) => {
      try {
        const result = await client.rpc(listRpc, {});
        setConnections(result.connections);
        setError(result.error);
        setSelected((current) =>
          current &&
          result.connections.some((value) => value.config.id === current)
            ? current
            : (result.connections[0]?.config.id ?? null),
        );
        if (
          result.daemonConnected &&
          (includeChoices || !choicesReady.current)
        ) {
          setChoices(await client.rpc(choicesRpc, {}));
          choicesReady.current = true;
        }
      } catch (error) {
        setError(errorText(error));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );
  useEffect(() => {
    let disposed = false;
    const initial = async () => {
      if (!disposed) await refresh(true);
    };
    void initial();
    const timer = setInterval(() => {
      if (!disposed) void refresh();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [refresh]);
  const active = connections.find((value) => value.config.id === selected);
  const choose = (id: string) => {
    setSelected(id);
    setAdding(false);
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }}>
      <View
        style={{
          paddingHorizontal: layout.compact ? 18 : 28,
          paddingVertical: 22,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            gap: 13,
            alignItems: "center",
            flex: 1,
          }}
        >
          <View
            style={{
              padding: 11,
              borderRadius: 13,
              backgroundColor: c.surface2,
            }}
          >
            <Icon name="Send" size={23} color={c.accent} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text
              style={{ color: c.foreground, fontSize: 21, fontWeight: "600" }}
            >
              Telegram
            </Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
              Connect conversations to Paseo.
            </Text>
          </View>
        </View>
        <Button
          theme={theme}
          title={refreshing ? "Refreshing…" : "Refresh"}
          secondary
          disabled={refreshing}
          onPress={() => {
            setRefreshing(true);
            void refresh(true).finally(() => setRefreshing(false));
          }}
        />
      </View>
      {!!error && (
        <View style={{ margin: 18 }}>
          <Notice theme={theme} error>
            {error}
          </Notice>
        </View>
      )}
      {loading ? (
        <Text
          accessibilityRole="progressbar"
          style={{ color: c.foregroundMuted, padding: 28 }}
        >
          Loading connections…
        </Text>
      ) : (
        <View
          style={{ flex: 1, flexDirection: layout.compact ? "column" : "row" }}
        >
          {connections.length > 0 && (
            <View
              style={
                layout.compact
                  ? {
                      padding: 18,
                      gap: 10,
                      borderBottomWidth: 1,
                      borderBottomColor: c.border,
                    }
                  : {
                      width: 260,
                      padding: 16,
                      gap: 10,
                      borderRightWidth: 1,
                      borderRightColor: c.border,
                    }
              }
            >
              {layout.compact ? (
                <SettingsSelect
                  label="Telegram bot"
                  value={adding ? "new" : (selected ?? "")}
                  options={[
                    ...connections.map((value) => ({
                      value: value.config.id,
                      label: `@${value.config.username}`,
                    })),
                    { value: "new", label: "+ Connect another bot" },
                  ]}
                  onValueChange={(value) =>
                    value === "new" ? setAdding(true) : choose(value)
                  }
                />
              ) : (
                <>
                  <Text
                    style={{
                      color: c.foregroundMuted,
                      fontSize: 11,
                      fontWeight: "600",
                      letterSpacing: 1,
                      padding: 8,
                    }}
                  >
                    CONNECTIONS
                  </Text>
                  {connections.map((value) => (
                    <Pressable
                      key={value.config.id}
                      accessibilityRole="button"
                      onPress={() => choose(value.config.id)}
                      style={{
                        borderRadius: 10,
                        padding: 13,
                        backgroundColor:
                          !adding && value.config.id === selected
                            ? c.surface2
                            : c.surface0,
                        gap: 6,
                      }}
                    >
                      <Text
                        style={{
                          color: c.foreground,
                          fontSize: 14,
                          fontWeight: "600",
                        }}
                      >
                        {value.config.name}
                      </Text>
                      <Text
                        numberOfLines={1}
                        style={{ color: c.foregroundMuted, fontSize: 12 }}
                      >
                        @{value.config.username}
                      </Text>
                      <Text
                        style={{
                          color: value.lastError
                            ? c.statusDanger
                            : value.running && value.ownerId
                              ? c.statusSuccess
                              : c.foregroundMuted,
                          fontSize: 11,
                        }}
                      >
                        {value.lastError
                          ? "Needs attention"
                          : !value.config.enabled
                            ? "Paused"
                            : !value.ownerId
                              ? "Pair owner"
                              : value.running
                                ? "Connected"
                                : "Connecting"}
                      </Text>
                    </Pressable>
                  ))}
                  <Button
                    theme={theme}
                    title="+ Connect a bot"
                    secondary
                    onPress={() => setAdding(true)}
                  />
                </>
              )}
            </View>
          )}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              padding: layout.compact ? 18 : 28,
              paddingBottom: 64,
            }}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={{
                width: "100%",
                maxWidth: 760,
                alignSelf: connections.length ? "flex-start" : "center",
                gap: 24,
              }}
            >
              {adding || !connections.length ? (
                <AddConnection
                  client={client}
                  theme={theme}
                  onAdded={async (id) => {
                    setAdding(false);
                    setSelected(id);
                    await refresh(true);
                  }}
                  onCancel={
                    connections.length ? () => setAdding(false) : undefined
                  }
                />
              ) : (
                active && (
                  <ConnectionEditor
                    key={active.config.id}
                    {...props}
                    client={client}
                    connection={active}
                    choices={choices}
                    refresh={() => refresh(true)}
                  />
                )
              )}
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}
function AddConnection({
  client,
  theme,
  onAdded,
  onCancel,
}: {
  client: Client;
  theme: PluginScreenProps["theme"];
  onAdded(id: string): Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.rpc(addRpc, {
        name: name.trim(),
        token: token.trim(),
      });
      setToken("");
      await onAdded(result.id);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 23 }}>
      <View style={{ gap: 8 }}>
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 23,
            fontWeight: "600",
          }}
        >
          Bring a conversation into Paseo
        </Text>
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 14,
            lineHeight: 22,
          }}
        >
          Link an existing chat, or give each Telegram group and topic its own
          agent. Bots profiles are optional.
        </Text>
      </View>
      <SettingsSection title="1 · Connect your Telegram bot">
        <View style={{ gap: 18 }}>
          <Field
            theme={theme}
            label="Connection name"
            value={name}
            onChange={setName}
            placeholder="Support, team, or personal assistant"
          />
          <Field
            theme={theme}
            label="Bot token"
            value={token}
            onChange={setToken}
            placeholder="Paste the token from BotFather"
            secure
            testID="bot-token"
            hint="Stored privately on the daemon. The token is never returned to the app."
          />
          <ExternalLink href="https://t.me/BotFather">
            Create or manage a bot in @BotFather
          </ExternalLink>
        </View>
      </SettingsSection>
      {!!error && (
        <Notice theme={theme} error>
          {error}
        </Notice>
      )}
      <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
        <Button
          theme={theme}
          title={busy ? "Connecting…" : "Connect bot"}
          disabled={
            busy ||
            !name.trim() ||
            !/^\d{5,16}:[A-Za-z0-9_-]{20,160}$/.test(token.trim())
          }
          onPress={() => void connect()}
        />
        {onCancel && (
          <Button
            theme={theme}
            title="Cancel"
            secondary
            onPress={onCancel}
            disabled={busy}
          />
        )}
      </View>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 12,
          lineHeight: 20,
        }}
      >
        Next: confirm your Telegram account, choose a Paseo destination, and add
        the bot to your groups. Polling needs no public URL or webhook.
      </Text>
    </View>
  );
}

function ConnectionEditor({
  client,
  connection,
  choices,
  refresh,
  theme,
  navigation,
}: PluginScreenProps & {
  client: Client;
  connection: ConnectionView;
  choices: Choices;
  refresh(): Promise<void>;
}) {
  const [draft, setDraft] = useState<Connection>(connection.config);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    url: string;
    expiresAt: number;
  } | null>(null);
  const [scope, setScope] = useState("default");
  const [operators, setOperators] = useState(
    connection.config.policy.operators.join(", "),
  );
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setDraft(connection.config);
      setOperators(connection.config.policy.operators.join(", "));
    }
  }, [connection.config.revision, dirty]);
  useEffect(() => {
    if (connection.ownerId !== null) setPairing(null);
  }, [connection.ownerId]);
  const patch = (value: Partial<Connection>) => {
    setDraft((current) => ({ ...current, ...value }));
    setDirty(true);
    setSuccess(null);
  };
  const policy = (value: Partial<Connection["policy"]>) =>
    patch({ policy: { ...draft.policy, ...value } });
  const validOperators = operators
    .split(/[\s,]+/)
    .filter(Boolean)
    .every(
      (value) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
    );
  const validation = connectionSchema.safeParse(draft);
  const complete =
    validation.success &&
    (!draft.target ||
      draft.target.kind === "agent" ||
      draft.target.profile.kind === "bots" ||
      /^[^/]+\/.+$/.test(draft.target.profile.provider));
  const action = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await operation();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const scopes = [
    ...new Map([
      ...connection.groups.map(
        (group) => [`${group.id}:0`, `${group.title} · all topics`] as const,
      ),
      ...connection.conversations.map(
        (value) =>
          [
            value.key,
            `${value.title} · ${value.key.split(":")[1] === "0" ? "chat" : `topic ${value.key.split(":")[1]}`}`,
          ] as const,
      ),
      ...Object.keys(draft.bindings).map(
        (key) => [key, `Conversation ${key}`] as const,
      ),
    ]).entries(),
  ];
  const target =
    scope === "default" ? draft.target : (draft.bindings[scope] ?? null);
  const setTarget = (target: Target | null) => {
    if (scope === "default") patch({ target });
    else {
      const bindings = { ...draft.bindings };
      if (target) bindings[scope] = target;
      else delete bindings[scope];
      patch({ bindings });
    }
  };
  return (
    <View style={{ gap: 25 }}>
      <View
        style={{
          gap: 6,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <View style={{ gap: 4 }}>
          <Text
            style={{
              color: theme.colors.foreground,
              fontSize: 22,
              fontWeight: "600",
            }}
          >
            {connection.config.name}
          </Text>
          <ExternalLink href={`https://t.me/${connection.config.username}`}>
            @{connection.config.username}
          </ExternalLink>
        </View>
        <Text
          style={{
            color: connection.lastError
              ? theme.colors.statusDanger
              : connection.running && connection.ownerId
                ? theme.colors.statusSuccess
                : theme.colors.foregroundMuted,
            fontSize: 13,
          }}
        >
          {!connection.config.enabled
            ? "Paused"
            : !connection.ownerId
              ? "Waiting for owner"
              : connection.running
                ? `Connected${connection.queued ? ` · ${connection.queued} queued` : ""}`
                : "Connecting…"}
        </Text>
      </View>
      {!!connection.lastError && (
        <Notice theme={theme} error>
          {connection.lastError}
        </Notice>
      )}
      {connection.ownerId === null && (
        <SettingsSection title="2 · Confirm the owner">
          <View style={{ gap: 14 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 13,
                lineHeight: 21,
              }}
            >
              Open the private setup link with your Telegram account and press
              Start. Only that account can admit this bot to groups.
            </Text>
            {pairing ? (
              <>
                <ExternalLink href={pairing.url}>
                  Open Telegram and confirm
                </ExternalLink>
                <Text
                  selectable
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 12,
                    lineHeight: 18,
                  }}
                >
                  {pairing.url}
                </Text>
                <Button
                  theme={theme}
                  title="Copy setup link"
                  secondary
                  onPress={() =>
                    void action(async () => {
                      await copyText(pairing.url);
                      setSuccess("Setup link copied.");
                    })
                  }
                />
                <Text
                  style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
                >
                  The link expires in 30 minutes. Keep it private.
                </Text>
              </>
            ) : (
              <Button
                theme={theme}
                title="Create private setup link"
                disabled={busy || !draft.enabled}
                onPress={() =>
                  void action(async () =>
                    setPairing(await client.rpc(pairRpc, { id: draft.id })),
                  )
                }
              />
            )}
          </View>
        </SettingsSection>
      )}
      <SettingsSection title="Conversation routing">
        <View style={{ gap: 19 }}>
          {scopes.length > 0 && (
            <SettingsSelect
              label="Configure routing for"
              value={scope}
              options={[
                { value: "default", label: "Default for new conversations" },
                ...scopes.map(([value, label]) => ({ value, label })),
              ]}
              onValueChange={setScope}
            />
          )}
          {scope !== "default" && (
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              A destination here overrides the default. Choose no destination to
              inherit the default again.
            </Text>
          )}
          <RouteEditor
            key={scope}
            theme={theme}
            target={target}
            onChange={setTarget}
            choices={choices}
          />
        </View>
      </SettingsSection>
      <SettingsSection title="Who can use the agent?">
        <View style={{ gap: 17 }}>
          <SettingsSelect
            label="Direct messages"
            value={draft.policy.directMessages}
            options={[
              { value: "owner", label: "Owner only" },
              { value: "operators", label: "Owner and allowed users" },
              { value: "everyone", label: "Anyone" },
            ]}
            onValueChange={(directMessages) => policy({ directMessages })}
          />
          <SettingsSelect
            label="Requests inside admitted groups"
            value={draft.policy.groupUsers}
            options={[
              { value: "operators", label: "Owner and allowed users" },
              { value: "everyone", label: "All group members" },
            ]}
            onValueChange={(groupUsers) => policy({ groupUsers })}
          />
          <Field
            theme={theme}
            label="Allowed Telegram user IDs"
            value={operators}
            onChange={(value) => {
              setOperators(value);
              if (
                value
                  .split(/[\s,]+/)
                  .filter(Boolean)
                  .every(
                    (part) =>
                      /^\d+$/.test(part) && Number.isSafeInteger(Number(part)),
                  )
              )
                policy({
                  operators: value
                    .split(/[\s,]+/)
                    .filter(Boolean)
                    .map(Number),
                });
              else {
                setDirty(true);
              }
            }}
            placeholder="Numeric user IDs, separated by commas"
            error={
              !validOperators ? "Enter numeric Telegram user IDs." : undefined
            }
            hint="The paired owner is always allowed. These users cannot admit new groups."
          />
          <SettingsSelect
            label="When to respond in groups"
            value={draft.policy.invocation}
            options={[
              { value: "mentions", label: "Mentions and replies to the bot" },
              { value: "all", label: "Every text message" },
            ]}
            onValueChange={(invocation) => policy({ invocation })}
          />
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 12,
              lineHeight: 19,
            }}
          >
            Requests use the linked agent’s tools and permissions. For ordinary
            group mentions, disable Group Privacy in BotFather before adding the
            bot. Inline Mode is not needed.
          </Text>
        </View>
      </SettingsSection>
      {connection.conversations.length > 0 && (
        <SettingsSection title="Linked conversations">
          <View style={{ gap: 15 }}>
            {connection.conversations.map((value) => (
              <View
                key={`${value.key}:${value.agentId}`}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  gap: 14,
                  alignItems: "center",
                }}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <Text
                    style={{ color: theme.colors.foreground, fontSize: 14 }}
                  >
                    {value.title}
                  </Text>
                  <Text
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: 12,
                    }}
                  >
                    {value.key.split(":")[1] === "0"
                      ? "Chat"
                      : `Topic ${value.key.split(":")[1]}`}{" "}
                    ·{" "}
                    {value.active
                      ? "Working"
                      : value.current === false
                        ? "Previous route"
                        : "Ready"}
                  </Text>
                </View>
                {!!navigation?.openAgent && (
                  <Button
                    theme={theme}
                    title="Open in Paseo"
                    secondary
                    onPress={() =>
                      navigation.openAgent({ agentId: value.agentId })
                    }
                  />
                )}
              </View>
            ))}
          </View>
        </SettingsSection>
      )}
      {connection.groups.length > 0 && (
        <SettingsSection title="Admitted groups">
          <View style={{ gap: 12 }}>
            {connection.groups.map((group) => (
              <View
                key={group.id}
                style={{
                  flexDirection: "row",
                  gap: 12,
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 13,
                    flex: 1,
                  }}
                >
                  {group.title}
                </Text>
                <Button
                  theme={theme}
                  title="Revoke"
                  secondary
                  disabled={busy}
                  onPress={() =>
                    void action(async () => {
                      await client.rpc(revokeRpc, {
                        id: draft.id,
                        chatId: group.id,
                      });
                      await refresh();
                    })
                  }
                />
              </View>
            ))}
          </View>
        </SettingsSection>
      )}
      <SettingsSection title="Connection">
        <View style={{ gap: 17 }}>
          <Field
            theme={theme}
            label="Connection name"
            value={draft.name}
            onChange={(name) => patch({ name })}
          />
          <SettingsSwitch
            label="Receive Telegram messages"
            hint="Pausing stops reception and delivery. It keeps the chats, history and pending requests."
            value={draft.enabled}
            onValueChange={(enabled) => patch({ enabled })}
          />
        </View>
      </SettingsSection>
      {dirty && draft.revision !== connection.config.revision && (
        <Notice theme={theme} error>
          These settings changed on another client. Discard your edits to load
          the latest version.
        </Notice>
      )}
      {dirty && !complete && (
        <Notice theme={theme}>
          Choose a complete destination and profile before saving.
        </Notice>
      )}
      {!!error && (
        <Notice theme={theme} error>
          {error}
        </Notice>
      )}
      {!!success && <Notice theme={theme}>{success}</Notice>}
      <View style={{ gap: 12, flexDirection: "row", flexWrap: "wrap" }}>
        <Button
          theme={theme}
          title={busy ? "Saving…" : "Save settings"}
          disabled={
            !dirty ||
            busy ||
            !complete ||
            !validOperators ||
            draft.revision !== connection.config.revision
          }
          onPress={() =>
            void action(async () => {
              const updated = await client.rpc(saveRpc, {
                id: draft.id,
                revision: draft.revision,
                name: draft.name,
                enabled: draft.enabled,
                target: draft.target,
                policy: draft.policy,
                bindings: draft.bindings,
              });
              setDraft(updated);
              await refresh();
              setDirty(false);
              setSuccess("Settings saved.");
            })
          }
        />
        {dirty && (
          <Button
            theme={theme}
            title="Discard edits"
            secondary
            disabled={busy}
            onPress={() => {
              setDraft(connection.config);
              setOperators(connection.config.policy.operators.join(", "));
              setDirty(false);
              setError(null);
            }}
          />
        )}
      </View>
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          paddingTop: 22,
          gap: 12,
        }}
      >
        {confirmRemove ? (
          <>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: 13,
                lineHeight: 21,
              }}
            >
              Disconnect @{draft.username}? Its saved token is removed. Paseo
              chats, Git worktrees and conversation history are kept.
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Button
                theme={theme}
                title="Disconnect bot"
                danger
                disabled={busy}
                onPress={() =>
                  void action(async () => {
                    await client.rpc(disconnectRpc, { id: draft.id });
                    await refresh();
                  })
                }
              />
              <Button
                theme={theme}
                title="Cancel"
                secondary
                onPress={() => setConfirmRemove(false)}
              />
            </View>
          </>
        ) : (
          <Button
            theme={theme}
            title="Disconnect…"
            secondary
            danger
            onPress={() => setConfirmRemove(true)}
          />
        )}
      </View>
    </View>
  );
}
