import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import assert from "node:assert/strict";
import { build } from "esbuild";
await mkdir(".context", { recursive: true });
await build({
  entryPoints: ["tests/ui/entry.tsx"],
  outfile: ".context/preview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    "react-native": "react-native-web",
    "@getpaseo/plugin/client/ui": resolve("tests/ui/host.tsx"),
    "@getpaseo/plugin/client/react-native": resolve("tests/ui/host.tsx"),
  },
});
await writeFile(
  ".context/preview.html",
  '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body,#root{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;background:#141917}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="preview.js"></script></body></html>',
);
const profile = await mkdtemp(join(tmpdir(), "paseo-telegram-browser-"));
const chrome = spawn(
  process.argv[2] || process.env.CHROME_BIN || "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let startupError;
let startupLog = "";
chrome.on("error", (error) => {
  startupError = error;
});
chrome.stderr.on("data", (chunk) => {
  startupLog = (startupLog + chunk.toString()).slice(-8000);
});
let socket;
const errors = [];
try {
  let port;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupError || chrome.exitCode !== null || chrome.signalCode !== null)
      throw Error(
        `Browser exited during startup: ${startupError?.message ?? chrome.exitCode ?? chrome.signalCode}\n${startupLog}`,
      );
    try {
      port = Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      );
      if (Number.isInteger(port) && port > 0 && port <= 65535) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error(
      `Browser did not become ready within 30 seconds\n${startupLog}`,
    );
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  socket = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await once(socket, "open");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (e) => {
    const d = JSON.parse(e.data);
    if (d.method === "Runtime.exceptionThrown")
      errors.push(d.params.exceptionDetails.text);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = () => new Promise((r) => setTimeout(r, 150));
  const text = () => evaluate(`document.body.textContent`);
  const navigate = async (query = "") => {
    await send("Page.navigate", { url: url + query });
    await new Promise((r) => setTimeout(r, 400));
  };
  const select = async (label, value) => {
    await evaluate(
      `(()=>{const e=document.querySelector('select[aria-label=${JSON.stringify(label)}]');if(!e)throw Error('Missing select');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait();
  };
  const click = async (title) => {
    await evaluate(
      `(()=>{const e=[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent===${JSON.stringify(title)});if(!e||e.getAttribute('aria-disabled')==='true')throw Error('Button unavailable: '+${JSON.stringify(title)});e.click();})()`,
    );
    await wait();
  };
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const url = pathToFileURL(resolve(".context/preview.html")).href;
  await send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    await evaluate(
      `!!document.querySelector('select[aria-label="Paseo chat"]')`,
    ),
    false,
  );
  assert.equal(
    await evaluate(
      `document.body.textContent.includes('Conversation routing')`,
    ),
    true,
  );
  await mkdir(".context/ui-check", { recursive: true });
  let shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".context/ui-check/desktop.png",
    Buffer.from(shot.data, "base64"),
  );
  await select("Send Telegram messages to", "agent");
  await select("Paseo chat", "personal");
  await new Promise((r) => setTimeout(r, 5500));
  assert.equal(
    await evaluate(
      `document.querySelector('select[aria-label="Paseo chat"]').value`,
    ),
    "personal",
  );
  await click("Save settings");
  assert.equal(
    await evaluate(
      `globalThis.__calls.filter(c=>c.name==='telegram.save').at(-1).input.target.agentId`,
    ),
    "personal",
  );
  await select("Send Telegram messages to", "workspace");
  await select("Workspace", "backend");
  await select("Settings for new agents", "bots");
  await select("Bots profile", "support");
  await click("Save settings");
  assert.equal(
    await evaluate(
      `globalThis.__calls.filter(c=>c.name==='telegram.save').at(-1).input.target.profile.botId`,
    ),
    "support",
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await wait();
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
    true,
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('select[aria-label="Telegram bot"]')`,
    ),
    true,
  );
  shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".context/ui-check/mobile.png",
    Buffer.from(shot.data, "base64"),
  );
  // Admission and request permissions are independent and survive saving.
  for (const admission of ["operators", "approval", "everyone", "owner"]) {
    await select("Who can connect groups", admission);
    await select("Requests inside admitted groups", "admins");
    assert.match(await text(), /Telegram verifies group administrator roles/);
    await click("Save settings");
    const policy = await evaluate(
      `globalThis.__calls.filter(c=>c.name==='telegram.save').at(-1).input.policy`,
    );
    assert.equal(policy.groupAdmission, admission);
    assert.equal(policy.groupUsers, "admins");
    assert.equal(
      await evaluate(
        `document.querySelector('select[aria-label="Who can connect groups"]').value`,
      ),
      admission,
    );
  }
  await navigate("?pending=1");
  assert.match(await text(), /Groups awaiting approval/);
  await evaluate(
    `document.querySelector('[aria-label="Approve New community"]').scrollIntoView({block:'center'})`,
  );
  await wait();
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
    true,
  );
  shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".context/ui-check/approval-phone.png",
    Buffer.from(shot.data, "base64"),
  );
  await click("Approve");
  assert.equal(
    await evaluate(
      `globalThis.__calls.filter(c=>c.name==='telegram.review').at(-1).input.approve`,
    ),
    true,
  );
  assert.match(await text(), /Group approved/);
  assert.doesNotMatch(await text(), /Groups awaiting approval/);
  await navigate("?pending=1");
  await click("Reject");
  assert.equal(
    await evaluate(
      `globalThis.__calls.filter(c=>c.name==='telegram.review').at(-1).input.approve`,
    ),
    false,
  );
  assert.match(await text(), /Group rejected/);
  assert.doesNotMatch(await text(), /Groups awaiting approval/);

  await navigate("?pending=1");
  await select("Requests inside admitted groups", "everyone");
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-label="Approve New community"]').getAttribute('aria-disabled')`,
    ),
    "true",
  );
  await click("Discard edits");
  assert.notEqual(
    await evaluate(
      `document.querySelector('[aria-label="Approve New community"]').getAttribute('aria-disabled')`,
    ),
    "true",
  );
  // A connected token is not a ready agent; only saved routing activates replies.
  await navigate("?setup=1");
  assert.match(await text(), /Choose destination/);
  assert.match(await text(), /Setup incomplete/);
  assert.doesNotMatch(await text(), /Ready/);
  shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".context/ui-check/setup-mobile.png",
    Buffer.from(shot.data, "base64"),
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait();
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
    true,
  );
  shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".context/ui-check/setup-desktop.png",
    Buffer.from(shot.data, "base64"),
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await wait();
  await select("Send Telegram messages to", "agent");
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-label="Save settings"]').getAttribute('aria-disabled')`,
    ),
    "true",
  );
  await select("Paseo chat", "personal");
  assert.match(await text(), /Destination not saved yet/);
  assert.doesNotMatch(await text(), /Ready/);
  await click("Save settings");
  assert.match(await text(), /Ready/);
  assert.doesNotMatch(
    await text(),
    /Setup incomplete|Destination not saved yet/,
  );

  // Confirming the owner remains a separate required step, including when a
  // destination was configured first. Simulate Telegram Start, never a real bot.
  await navigate("?unpaired=1");
  assert.match(await text(), /Confirm owner/);
  assert.doesNotMatch(await text(), /Ready/);
  await click("Create private setup link");
  await click("Copy setup link");
  assert.equal(
    await evaluate(`globalThis.__copied`),
    "https://t.me/example_help_bot?start=example",
  );
  await evaluate(`globalThis.__confirmOwner()`);
  await click("Refresh");
  assert.match(await text(), /Ready/);
  assert.doesNotMatch(await text(), /Confirm owner|Open Telegram and confirm/);

  await navigate("?overrides=1");
  assert.match(await text(), /Ready for selected chats/);
  assert.match(
    await text(),
    /only for conversations with their own saved destination/,
  );

  // Telegram's default privacy must never produce a green connection status.
  await navigate("?privacy=1");
  assert.match(await text(), /Group setup needed/);
  assert.match(await text(), /Telegram is hiding ordinary @mentions/);
  assert.match(await text(), /\/ask@example_help_bot/);
  assert.equal(
    await evaluate(
      `document.querySelector('a[href="https://t.me/example_help_bot?startgroup&admin=manage_chat"]').textContent`,
    ),
    "Add to group",
  );
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
    true,
  );
  await evaluate(
    `document.querySelector('[aria-label="Check group access"]').scrollIntoView({block:'center'})`,
  );
  shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".context/ui-check/group-setup-mobile.png",
    Buffer.from(shot.data, "base64"),
  );
  await click("Check group access");
  assert.equal(
    await evaluate(
      `globalThis.__calls.filter(c=>c.name==='telegram.check-groups').length`,
    ),
    1,
  );
  assert.match(await text(), /Group message access is ready/);
  assert.doesNotMatch(await text(), /Group setup needed/);
  await navigate("?unverified=1");
  assert.match(await text(), /Group message access has not been verified/);
  assert.doesNotMatch(await text(), /Group message access is ready/);

  // Workspace onboarding explains the prerequisite and cannot save a missing model.
  await navigate("?setup=1&no-providers=1");
  await select("Send Telegram messages to", "workspace");
  await select("Workspace", "backend");
  assert.match(await text(), /No providers are available/);
  assert.equal(
    await evaluate(
      `document.querySelector('[aria-label="Save settings"]').getAttribute('aria-disabled')`,
    ),
    "true",
  );
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
    true,
  );
  await send("Page.navigate", { url: url + "?empty=1" });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(
    await evaluate(
      `document.body.textContent.includes('Bring a conversation into Paseo')`,
    ),
    true,
  );
  assert.match(await text(), /No bot code or separate hosting is needed/);
  assert.equal(
    await evaluate(
      `document.querySelector('input[aria-label="Bot token"]').type`,
    ),
    "password",
  );
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
    true,
  );
  await send("Page.navigate", {
    url:
      "data:text/html," +
      encodeURIComponent(
        '<html><body style="margin:0"><svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><rect width="128" height="128" rx="28" fill="#229ED9"/><g transform="translate(26 25) scale(3.2)" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></g></svg></body></html>',
      ),
  });
  await wait();
  const icon = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: 128, height: 128, scale: 1 },
  });
  await writeFile(
    ".context/ui-check/icon.png",
    Buffer.from(icon.data, "base64"),
  );
  assert.deepEqual(errors, []);
  const result = {
    passed: true,
    desktop: [1200, 960],
    phone: [390, 844],
    routingModes: true,
    optionalBots: true,
    setupReadiness: true,
    ownerPairing: true,
    unsavedDestinationInactive: true,
    perConversationOverrides: true,
    missingProviderGuidance: true,
    independentGroupPolicies: true,
    groupApprovalAndRejection: true,
    savePayloads: true,
    maskedToken: true,
    noHorizontalOverflow: true,
    reactErrors: errors,
    hostControls: "preview adapters",
    actualScreen: true,
  };
  await writeFile(
    ".context/browser-check.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  socket?.close();
  const ended = once(chrome, "exit");
  chrome.kill("SIGTERM");
  await Promise.race([ended, new Promise((r) => setTimeout(r, 1000))]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
