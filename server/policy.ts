import type { Connection } from "../shared/config.ts";
import { isGroup, type TelegramMessage } from "../shared/telegram.ts";
import type { State } from "./store.ts";

export function authorized(config: Connection, state: State, message: TelegramMessage): boolean {
  const user = message.from;
  if (!config.enabled || state.ownerId === null || !user || user.is_bot || message.sender_chat) return false;
  const operator = user.id === state.ownerId || config.policy.operators.includes(user.id);
  if (message.chat.type === "private") return config.policy.directMessages === "everyone" || (config.policy.directMessages === "operators" ? operator : user.id === state.ownerId);
  return isGroup(message.chat) && !!state.groups[String(message.chat.id)] && (operator || config.policy.groupUsers === "everyone");
}
