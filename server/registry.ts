import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { connectionSchema, type Connection } from "../shared/config.ts";
import { atomicWrite, readJson } from "./files.ts";

const documentSchema = z.object({ version: z.literal(1), connections: z.array(connectionSchema).max(20) }).strict();
export class Registry {
  connections: Connection[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  readonly root: string;
  constructor(root: string) { this.root = root; }
  async load(): Promise<void> {
    const value = await readJson(join(this.root, "connections.json"));
    if (value !== undefined) this.connections = documentSchema.parse(value).connections;
  }
  get(id: string): Connection { const value = this.connections.find(value => value.id === id); if (!value) throw new Error("Connection not found"); return value; }
  async token(id: string): Promise<string> {
    this.get(id);
    const value = await readJson(join(this.root, "secrets", `${id}.json`));
    return z.object({ token: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/) }).parse(value).token;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  add(name: string, token: string, identity: { id: number; username: string }): Promise<Connection> {
    return this.exclusive(async () => {
      if (this.connections.length >= 20) throw new Error("A maximum of 20 Telegram connections is supported");
      if (this.connections.some(value => value.botId === identity.id)) throw new Error("This Telegram bot is already connected");
      const config = connectionSchema.parse({ id: randomUUID(), name, enabled: true, botId: identity.id, username: identity.username, target: null, policy: {}, bindings: {}, revision: 0 });
      await atomicWrite(join(this.root, "secrets", `${config.id}.json`), { token });
      const next = [...this.connections, config];
      await atomicWrite(join(this.root, "connections.json"), { version: 1, connections: next });
      this.connections = next;
      return config;
    });
  }
  update(value: Connection): Promise<Connection> {
    return this.exclusive(async () => {
      const previous = this.get(value.id);
      if (value.revision !== previous.revision) throw new Error("Settings changed on another client. Refresh before saving.");
      const nextValue = connectionSchema.parse({ ...value, revision: value.revision + 1 });
      const next = this.connections.map(item => item.id === value.id ? nextValue : item);
      await atomicWrite(join(this.root, "connections.json"), { version: 1, connections: next });
      this.connections = next;
      return nextValue;
    });
  }
  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.get(id);
      const next = this.connections.filter(value => value.id !== id);
      await atomicWrite(join(this.root, "connections.json"), { version: 1, connections: next });
      this.connections = next;
      await unlink(join(this.root, "secrets", `${id}.json`)).catch(error => { if (error.code !== "ENOENT") throw error; });
    });
  }
}
