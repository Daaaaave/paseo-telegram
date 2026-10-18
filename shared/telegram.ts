export interface TelegramUser { id: number; is_bot?: boolean; username?: string }
export interface TelegramChat { id: number; type: string; title?: string }
export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: unknown;
  text?: string;
  entities?: { type: string; offset: number; length: number; user?: TelegramUser }[];
  reply_to_message?: { message_id?: number; from?: TelegramUser };
  migrate_to_chat_id?: number;
}
export interface Membership {
  status: string;
  is_member?: boolean;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: {
    chat: TelegramChat;
    from: TelegramUser;
    date: number;
    old_chat_member: Membership;
    new_chat_member: Membership;
  };
}

export function isMember(value: Membership): boolean {
  return ["member", "administrator", "creator"].includes(value.status)
    || (value.status === "restricted" && value.is_member === true);
}

export function isGroup(chat: TelegramChat): boolean {
  return chat.type === "group" || chat.type === "supergroup";
}

export function conversationKey(message: TelegramMessage): string {
  return `${message.chat.id}:${message.message_thread_id ?? 0}`;
}

/** Telegram entity offsets use UTF-16, as JavaScript string.slice does. */
export function isAddressed(message: TelegramMessage, botId: number, username: string): boolean {
  if (!message.from || message.from.is_bot || message.sender_chat || !message.text?.trim()) return false;
  if (message.reply_to_message?.from?.id === botId) return true;
  return (message.entities ?? []).some((entity) => {
    const text = message.text!.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (entity.type === "mention") return text === `@${username.toLowerCase()}`;
    if (entity.type === "text_mention") return entity.user?.id === botId;
    if (entity.type === "bot_command") return text === `/ask@${username.toLowerCase()}`;
    return false;
  });
}

export function chunks(text: string, limit = 3800): string[] {
  // Account for astral Unicode characters without splitting surrogate pairs.
  const output: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length + character.length > limit) {
      output.push(current);
      current = "";
    }
    current += character;
  }
  if (current) output.push(current);
  return output;
}
