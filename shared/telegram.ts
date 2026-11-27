export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}
export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}
export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: unknown;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  voice?: TelegramFile & { duration?: number };
  audio?: TelegramFile & { duration?: number; file_name?: string };
  photo?: (TelegramFile & { width?: number; height?: number })[];
  document?: TelegramFile & { file_name?: string };
  reply_to_message?: { message_id?: number; from?: TelegramUser };
  migrate_to_chat_id?: number;
}
export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}
export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  mime_type?: string;
}
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: {
    message_id: number;
    message_thread_id?: number;
    date: number;
    chat: TelegramChat;
  };
}
export interface Membership {
  status: string;
  is_member?: boolean;
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: {
    chat: TelegramChat;
    from: TelegramUser;
    date: number;
    old_chat_member: Membership;
    new_chat_member: Membership;
  };
}

export function isMember(value: Membership): boolean {
  return (
    ["member", "administrator", "creator"].includes(value.status) ||
    (value.status === "restricted" && value.is_member === true)
  );
}

export function isGroup(chat: TelegramChat): boolean {
  return chat.type === "group" || chat.type === "supergroup";
}

export function conversationKey(message: TelegramMessage): string {
  return `${message.chat.id}:${message.message_thread_id ?? 0}`;
}

export interface MediaItem {
  kind: "voice" | "audio" | "photo" | "document";
  fileId: string;
  fileSize?: number;
  duration?: number;
  fileName?: string;
  mimeType?: string;
}

/** The single downloadable attachment of a message, if any. A photo is sent in
 * several sizes; the largest one within `maxBytes` is chosen. */
export function mediaOf(
  message: TelegramMessage,
  maxBytes: number,
): MediaItem | undefined {
  if (message.voice)
    return {
      kind: "voice",
      fileId: message.voice.file_id,
      fileSize: message.voice.file_size,
      duration: message.voice.duration,
      mimeType: message.voice.mime_type,
    };
  if (message.audio)
    return {
      kind: "audio",
      fileId: message.audio.file_id,
      fileSize: message.audio.file_size,
      duration: message.audio.duration,
      fileName: message.audio.file_name,
      mimeType: message.audio.mime_type,
    };
  if (message.photo?.length) {
    const sizes = [...message.photo].sort(
      (a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0),
    );
    const fitting = sizes.filter((size) => (size.file_size ?? 0) <= maxBytes);
    const chosen = fitting.at(-1) ?? sizes[0];
    return {
      kind: "photo",
      fileId: chosen.file_id,
      fileSize: chosen.file_size,
      mimeType: "image/jpeg",
    };
  }
  if (message.document)
    return {
      kind: "document",
      fileId: message.document.file_id,
      fileSize: message.document.file_size,
      fileName: message.document.file_name,
      mimeType: message.document.mime_type,
    };
}

/** Telegram entity offsets use UTF-16, as JavaScript string.slice does. */
export function isAddressed(
  message: TelegramMessage,
  botId: number,
  username: string,
): boolean {
  const body = message.text ?? message.caption;
  const attachment = !!(
    message.voice ||
    message.audio ||
    message.photo?.length ||
    message.document
  );
  if (
    !message.from ||
    message.from.is_bot ||
    message.sender_chat ||
    (!body?.trim() && !attachment)
  )
    return false;
  if (message.reply_to_message?.from?.id === botId) return true;
  return ((message.text ? message.entities : message.caption_entities) ?? []).some((entity) => {
    const text = (body ?? "")
      .slice(entity.offset, entity.offset + entity.length)
      .toLowerCase();
    if (entity.type === "mention") return text === `@${username.toLowerCase()}`;
    if (entity.type === "text_mention") return entity.user?.id === botId;
    if (entity.type === "bot_command")
      return text === `/ask@${username.toLowerCase()}`;
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
