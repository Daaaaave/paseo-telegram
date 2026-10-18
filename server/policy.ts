import type { Connection } from "../shared/config.ts";
import { isGroup, type TelegramMessage } from "../shared/telegram.ts";
import type { State } from "./store.ts";

export function authorized(
  config: Connection,
  state: State,
  message: TelegramMessage,
  groupAdmin = false,
): boolean {
  const user = message.from;
  if (
    !config.enabled ||
    state.ownerId === null ||
    !user ||
    user.is_bot ||
    message.sender_chat
  )
    return false;
  const operator =
    user.id === state.ownerId || config.policy.operators.includes(user.id);
  if (message.chat.type === "private")
    return (
      config.policy.directMessages === "everyone" ||
      (config.policy.directMessages === "operators"
        ? operator
        : user.id === state.ownerId)
    );
  return (
    isGroup(message.chat) &&
    !!state.groups[String(message.chat.id)] &&
    (user.id === state.ownerId ||
      config.policy.groupUsers === "everyone" ||
      (config.policy.groupUsers === "admins" ? groupAdmin : operator))
  );
}

export function groupAdmission(
  config: Connection,
  state: State,
  addedBy: number,
): "admit" | "pending" | "reject" {
  if (state.ownerId === null || config.policy.groupAdmission === "approval")
    return "pending";
  return config.policy.groupAdmission === "everyone" ||
    addedBy === state.ownerId ||
    (config.policy.groupAdmission === "operators" &&
      config.policy.operators.includes(addedBy))
    ? "admit"
    : "reject";
}
