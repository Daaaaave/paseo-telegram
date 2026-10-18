import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { Registry } from "../server/registry.ts";
import { Store } from "../server/store.ts";
import { connectLocalDaemon } from "../server/daemon.ts";

const packageIdentity = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const source =
  process.argv[2] || `npm:${packageIdentity.name}@${packageIdentity.version}`;
if (!/^(?:npm:|github:|git:)/.test(source))
  throw new Error(
    "Use a managed Git or npm source; preparation must not modify a development checkout.",
  );
const exec = promisify(execFile),
  home = await mkdtemp(join(tmpdir(), "paseo-telegram-daemon-check-"));
const env = { ...process.env };
for (const name of Object.keys(env))
  if (name.startsWith("PASEO_")) delete env[name];
const record = join(home, "telegram-events.jsonl"),
  preload = join(home, "telegram-fixture.cjs");
const nonce = "a".repeat(32),
  botId = 77,
  username = "demo_help_bot";
await writeFile(
  join(home, "config.json"),
  JSON.stringify({
    version: 1,
    daemon: {
      listen: join(home, "daemon.sock"),
      relay: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false },
      browserTools: { enabled: false },
    },
    pluginsEnabled: true,
  }),
);
const registry = new Registry(join(home, "plugin-data", "telegram"));
await registry.load();
let config = await registry.add(
  "Headless fixture",
  `123456789:${"x".repeat(35)}`,
  { id: botId, username },
);
if (config.policy.groupAdmission !== "owner")
  throw new Error("A new connection must default to owner-only admission");
config = await registry.update({
  ...config,
  policy: { ...config.policy, groupAdmission: "approval" },
});
const store = new Store(
  join(home, "plugin-data", "telegram", "connections", config.id),
);
store.state.pairing = {
  hash: createHash("sha256").update(nonce).digest("hex"),
  expiresAt: Date.now() + 5 * 60_000,
};
await store.save();
const updates = [
  {
    update_id: 1,
    message: {
      message_id: 1,
      date: 100,
      chat: { id: 10, type: "private" },
      from: { id: 10 },
      text: "/start owner_" + nonce,
    },
  },
  {
    update_id: 2,
    message: {
      message_id: 2,
      date: 100,
      chat: { id: 10, type: "private" },
      from: { id: 10 },
      text: "Check this",
    },
  },
  ...[-100, -200].map((id, index) => ({
    update_id: index + 3,
    my_chat_member: {
      chat: { id, type: "supergroup", title: "Fixture group" },
      from: { id: 99 },
      date: 100,
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member" },
    },
  })),
  {
    update_id: 5,
    message: {
      message_id: 5,
      date: 100,
      chat: { id: -100, type: "supergroup" },
      from: { id: 99 },
      text: "/status@" + username,
    },
  },
];
await writeFile(
  preload,
  `
const fs = require('node:fs');
const original = globalThis.fetch;
let sent = false;
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (!url.startsWith('https://api.telegram.org/bot')) return original(input, options);
  const method = url.split('/').at(-1), payload = JSON.parse(options.body);
  let result;
  if (method === 'getMe') result = { id: ${botId}, username: ${JSON.stringify(username)}, is_bot: true };
  else if (method === 'getWebhookInfo') result = { url: '' };
  else if (method === 'getChatMember') result = { status: 'member' };
  else if (method === 'getUpdates') {
    if (!sent) { sent = true; result = ${JSON.stringify(updates)}; }
    else { await new Promise(r => setTimeout(r, 250)); result = []; }
  } else {
    result = { message_id: 100 };
    fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ method, text: payload.text, chatId: payload.chat_id }) + String.fromCharCode(10));
  }
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
};
`,
);

env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --require=${preload}`;
let started = false,
  probe;
try {
  started = true;
  await exec("paseo", ["daemon", "start", "--home", home, "--timeout", "30"], {
    env,
    timeout: 40_000,
  });
  await exec(
    "paseo",
    [
      "plugin",
      "install",
      source,
      ...(process.argv[3] ? ["--ref", process.argv[3]] : []),
      "--home",
      home,
      "--json",
    ],
    { env, timeout: 90_000, maxBuffer: 2_000_000 },
  );
  let events = [];
  for (let i = 0; i < 100; i++) {
    try {
      events = (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    } catch {}
    if (
      events.some((value) =>
        /Choose a Paseo chat|Setup incomplete/.test(value.text || ""),
      ) &&
      events.some((value) => /awaiting approval/.test(value.text || ""))
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (
    !events.some((value) => /Owner confirmed/.test(value.text || "")) ||
    !events.some((value) =>
      /Choose a Paseo chat|Setup incomplete/.test(value.text || ""),
    ) ||
    !events.some((value) => /awaiting approval/.test(value.text || ""))
  )
    throw new Error(
      "Receiver did not process the fixture before any UI/RPC connection",
    );
  probe = await connectLocalDaemon(home);
  const status = await probe.invoke("telegram", "telegram.list", {});
  if (
    !status.daemonConnected ||
    !status.connections[0]?.running ||
    status.connections[0]?.ownerId !== 10
  )
    throw new Error("Headless receiver status is unhealthy");
  const connection = status.connections[0];
  if (connection.groups.length || connection.pendingGroups.length !== 2)
    throw new Error("Pending groups became admitted before review");
  await probe.invoke("telegram", "telegram.review", {
    id: config.id,
    chatId: "-100",
    approve: true,
  });
  await probe.invoke("telegram", "telegram.review", {
    id: config.id,
    chatId: "-200",
    approve: false,
  });
  const reviewed = await probe.invoke("telegram", "telegram.list", {});
  if (
    reviewed.connections[0].pendingGroups.length ||
    reviewed.connections[0].groups.length !== 1 ||
    reviewed.connections[0].groups[0].id !== "-100"
  )
    throw new Error(
      "Group review did not persist admission and rejection correctly",
    );
  const finalEvents = (await readFile(record, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  if (
    !finalEvents.some(
      (value) => value.method === "leaveChat" && value.chatId === -200,
    )
  )
    throw new Error("Rejected group was not left");
  if (
    finalEvents.some((value) => /\p{Script=Cyrillic}/u.test(value.text || ""))
  )
    throw new Error("Connector fixture replies must use English");
  const result = {
    passed: true,
    source,
    ...(process.argv[3] ? { ref: process.argv[3] } : {}),
    isolated: true,
    headlessBeforeFirstRpc: true,
    realDaemon: true,
    telegramFixtureOnly: true,
    ownerPairing: true,
    receivedAndReplied: true,
    pendingGroupsDenied: true,
    approvalAndRejection: true,
    englishServiceMessages: true,
    connections: status.connections.length,
  };
  await writeFile(
    ".context/daemon-check.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await probe?.close();
  if (started)
    await exec("paseo", ["daemon", "stop", "--home", home, "--json"], {
      env,
      timeout: 25_000,
    });
  await rm(home, { recursive: true, force: true });
}
