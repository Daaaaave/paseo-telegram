import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { WebSocket } from "ws";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** The same local instance discovery and credential handshake used by the CLI.
 * Kept here because Paseo 0.11 gives plugins its API only inside RPCs/hooks.
 * Never accepts a remote endpoint or changes the daemon's global configuration.
 */
export function localTarget(listen: string): { url: string; socketPath?: string } {
  if (listen.startsWith("unix://")) listen = listen.slice(7);
  if (listen.startsWith("pipe://")) return { url: "ws://localhost/ws", socketPath: listen.slice(7) };
  if (listen.startsWith("\\\\.\\pipe\\")) return { url: "ws://localhost/ws", socketPath: listen };
  if (isAbsolute(listen)) return { url: `ws+unix://${listen}:/ws`, socketPath: listen };
  const match = /^(?:tcp:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{1,5})$/.exec(listen);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error("The local daemon has no supported loopback endpoint");
  const host = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1] === "[::]" ? "[::1]" : match[1];
  return { url: `ws://${host}:${match[2]}/ws` };
}
export type PluginInvoker = (plugin: string, method: string, input: unknown) => Promise<unknown>;
export interface DaemonConnection { api: PaseoApi; invoke: PluginInvoker; serverId: string | null; close(): Promise<void> }
export async function connectLocalDaemon(home: string): Promise<DaemonConnection> {
  let lock: { pid: number; listen: string; serverId?: string };
  try { lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")); }
  catch { throw new Error("Waiting for the local Paseo daemon"); }
  if (!Number.isSafeInteger(lock.pid) || typeof lock.listen !== "string") throw new Error("Waiting for the local Paseo endpoint");
  const target = localTarget(lock.listen);
  const client = new DaemonClient({
    url: target.url, clientId: "paseo-telegram", clientType: "cli", appVersion: "0.11.2", connectTimeoutMs: 8000,
    localCredential: async () => {
      const current = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"));
      if (current.pid !== lock.pid || current.listen !== lock.listen) throw new Error("Local daemon instance changed");
      try { const token = (await readFile(join(home, "local-credential"), "utf8")).trim(); return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined; }
      catch { return undefined; }
    },
    webSocketFactory: (url, options) => {
      const socket = new WebSocket(url, options?.protocols, { headers: options?.headers, ...(target.socketPath ? { socketPath: target.socketPath } : {}) });
      return { get readyState() { return socket.readyState; }, send: data => { socket.send(data); }, close: (code, reason) => { socket.close(code, reason); }, on: (event, listener) => { socket.on(event, listener); }, off: (event, listener) => { socket.off(event, listener); } };
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 15_000 },
  });
  try { await client.connect(); }
  catch { await client.close().catch(() => {}); throw new Error("Cannot connect to the local Paseo daemon"); }
  const api = createPaseoApi(client);
  return { api, serverId: lock.serverId ?? null, invoke: (plugin, method, input) => client.invokePluginRpc(plugin, method, input), close: async () => { await api.dispose(); await client.close(); } };
}
