import type { Connection } from "../shared/config.ts";
import type { GroupAccess, GroupPrivacy } from "../shared/group-setup.ts";
import { isMember, type Membership } from "../shared/telegram.ts";
import type { Store } from "./store.ts";
import type { Telegram } from "./telegram.ts";

/** Read-only, live checks; credentials and group admission stay with their owners. */
export class GroupSetup {
  privacy: GroupPrivacy = "unknown";
  private readonly members = new Map<string, Membership>();
  private lastAttempt = -Infinity;
  private pending?: Promise<void>;
  private readonly telegram: Telegram;
  private readonly store: Store;
  private readonly connection: () => Connection;
  private readonly signal: AbortSignal;
  private readonly now: () => number;
  constructor(
    telegram: Telegram,
    store: Store,
    connection: () => Connection,
    signal: AbortSignal,
    now = Date.now,
  ) {
    this.telegram = telegram;
    this.store = store;
    this.connection = connection;
    this.signal = signal;
    this.now = now;
  }

  access(id: string): GroupAccess {
    const member = this.members.get(id);
    if (!member) return "checking";
    if (!isMember(member)) return "not_member";
    if (["administrator", "creator"].includes(member.status)) return "ready";
    if (this.privacy === "unknown") return "checking";
    return this.privacy === "disabled" ? "ready" : "needs_admin";
  }

  observe(id: string, member: Membership): void {
    this.members.set(id, member);
  }

  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (
      this.signal.aborted ||
      (!force && this.now() - this.lastAttempt < 60_000)
    )
      return;
    this.lastAttempt = this.now();
    this.pending = this.check();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async check(): Promise<void> {
    const config = this.connection();
    try {
      const identity = await this.telegram.call<{
        id: number;
        can_read_all_group_messages?: boolean;
      }>("getMe", {}, this.signal);
      if (identity.id !== config.botId) {
        this.privacy = "unknown";
        this.members.clear();
        return;
      }
      this.privacy =
        identity.can_read_all_group_messages === true ? "disabled" : "enabled";
    } catch {
      this.privacy = "unknown";
    }
    for (const id of this.members.keys())
      if (!this.store.state.groups[id]) this.members.delete(id);
    await Promise.all(
      Object.keys(this.store.state.groups).map(async (id) => {
        const previous = this.members.get(id);
        let member: Membership | undefined;
        try {
          member = await this.telegram.call<Membership>(
            "getChatMember",
            {
              chat_id: Number(id),
              user_id: config.botId,
            },
            this.signal,
          );
          if (typeof member?.status !== "string") member = undefined;
        } catch {
          // An unavailable check must not leave a stale green Ready status.
        }
        // A membership update received during this request is newer evidence.
        if (this.members.get(id) === previous) {
          if (member) this.members.set(id, member);
          else this.members.delete(id);
        }
      }),
    );
  }
}
