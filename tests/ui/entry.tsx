import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { TelegramScreen } from "../../client/screen.tsx";
import { theme } from "./host";
const id = "12345678-1234-4234-8234-123456789012";
const params = new URLSearchParams(location.search);
const connection = {
  config: {
    id,
    name: "Customer support",
    enabled: true,
    botId: 77,
    username: "example_help_bot",
    target: {
      kind: "workspace",
      workspaceId: "backend",
      profile: {
        kind: "custom",
        provider: "example/model",
        systemPrompt:
          "Help customers understand the product. Investigate issues in this workspace and ask for clarification when needed.",
      },
      git: null,
    },
    policy: {
      groupAdmission: "owner",
      directMessages: "owner",
      groupUsers: "operators",
      operators: [],
      approvers: [],
      invocation: "mentions",
    },
    bindings: {},
    revision: 0,
  },
  ownerId: 12345,
  running: true,
  lastError: null,
  queued: 0,
  groupPrivacy: "enabled",
  groups: [{ id: "-100", title: "Customer community", access: "ready" }],
  pendingGroups: [] as { id: string; title: string }[],
  conversations: [
    {
      key: "-100:0",
      title: "Customer community",
      agentId: "agent",
      workspaceId: "backend",
      active: false,
    },
  ],
};
if (params.has("pending")) {
  connection.config.policy.groupAdmission = "approval";
  connection.pendingGroups = [{ id: "-200", title: "New community" }];
}
if (params.has("setup")) (connection.config as any).target = null;
if (params.has("unpaired")) (connection as any).ownerId = null;
if (params.has("privacy")) connection.groups[0].access = "needs_admin";
if (params.has("unverified")) connection.groups[0].access = "checking";
if (params.has("setup") || params.has("unpaired")) {
  connection.groups = [];
  connection.conversations = [];
}
if (params.has("overrides")) {
  (connection.config as any).bindings = { "-100:0": connection.config.target };
  (connection.config as any).target = null;
}
(globalThis as any).__confirmOwner = () => {
  connection.ownerId = 12345;
};
const choices = {
  agents: [
    {
      id: "agent",
      title: "Support · Customer community",
      workspaceId: "backend",
    },
    { id: "personal", title: "Product planning", workspaceId: "backend" },
  ],
  workspaces: [
    {
      id: "backend",
      title: "Development",
      project: "Product",
      directory: "/projects/product",
    },
  ],
  providers: [
    {
      id: "example",
      label: "Example provider",
      models: [{ id: "model", label: "Example model", thinking: [] }],
      modes: [
        { id: "review", label: "Ask for approval" },
        { id: "bypassPermissions", label: "Bypass" },
      ],
    },
  ],
  bots: [{ id: "support", name: "Customer Support" }],
  botsAvailable: true,
  botsError: null,
};
if (params.has("no-providers")) choices.providers = [];
(globalThis as any).__calls = [];
const client = {
  rpc: async (contract: any, input: any) => {
    (globalThis as any).__calls.push({ name: contract.name, input });
    if (contract.name === "telegram.list")
      return {
        connections: new URLSearchParams(location.search).has("empty")
          ? []
          : [connection],
        daemonConnected: true,
        error: null,
      };
    if (contract.name === "telegram.choices") return choices;
    if (contract.name === "telegram.save") {
      connection.config = {
        ...connection.config,
        ...input,
        revision: input.revision + 1,
      };
      return connection.config;
    }
    if (contract.name === "telegram.pair")
      return {
        url: "https://t.me/example_help_bot?start=example",
        expiresAt: Date.now() + 1800000,
      };
    if (contract.name === "telegram.review") {
      const group = connection.pendingGroups.find((g) => g.id === input.chatId);
      if (!group) throw new Error("No pending group");
      if (input.approve) connection.groups.push({ ...group, access: "ready" });
      connection.pendingGroups = connection.pendingGroups.filter(
        (g) => g.id !== input.chatId,
      );
      return { approved: input.approve };
    }
    if (contract.name === "telegram.check-groups") {
      connection.groups.forEach((group) => {
        group.access = "ready";
      });
      return {};
    }
    return {};
  },
};
function App() {
  const [width, setWidth] = useState(innerWidth);
  useEffect(() => {
    const handler = () => setWidth(innerWidth);
    addEventListener("resize", handler);
    return () => removeEventListener("resize", handler);
  }, []);
  return (
    <TelegramScreen
      client={client as any}
      theme={theme}
      host={{ id: "preview", label: "Preview" }}
      layout={{ compact: width < 700, platform: "web" }}
      params={{}}
      navigation={{
        openAgent: (input) => ((globalThis as any).__opened = input),
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(<App />);
