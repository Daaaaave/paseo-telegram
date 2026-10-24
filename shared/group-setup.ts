export type GroupAccess = "ready" | "needs_admin" | "not_member" | "checking";
export type GroupPrivacy = "enabled" | "disabled" | "unknown";

/** Telegram asks the user to confirm; no moderation privileges are requested. */
export function groupInviteUrl(username: string): string {
  return `https://t.me/${encodeURIComponent(username)}?startgroup&admin=manage_chat`;
}

export function groupAccessText(username: string, access: GroupAccess): string {
  switch (access) {
    case "ready":
      return "Group message access is ready.";
    case "needs_admin":
      return `Group setup is incomplete: Telegram is hiding ordinary @mentions from this bot. Select Fix group access, choose this group and confirm administrator access. Until then, use /ask@${username} followed by your question, or reply to one of the bot's messages.`;
    case "not_member":
      return "The bot is no longer a member of this group. Add it again to restore message access.";
    case "checking":
      return "Group message access has not been verified. Open Paseo → Telegram and select Check group access to try again.";
  }
}
