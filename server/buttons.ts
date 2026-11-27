import type { TelegramCallbackQuery, TelegramMessage } from "../shared/telegram.ts";

/** Callback data is capped at 64 bytes by Telegram. */
const PREFIX = "reply:";
const MAX_DATA_BYTES = 64;
const MAX_BUTTONS = 6;

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** An agent offers buttons by ending its reply with `[buttons: OK push | Clore]`.
 * The marker is removed from the visible text. */
export function extractButtons(answer: string): {
  text: string;
  buttons: string[];
} {
  const body = answer.trimEnd();
  const match = /(?:^|\n)[ \t]*\[buttons:([^\]\n]+)\]$/i.exec(body);
  if (!match) return { text: answer, buttons: [] };
  const buttons = [
    ...new Set(
      match[1]
        .split("|")
        .map((label) => label.trim())
        .filter(
          (label) =>
            label &&
            Buffer.byteLength(PREFIX + label) <= MAX_DATA_BYTES,
        ),
    ),
  ].slice(0, MAX_BUTTONS);
  const text = body.slice(0, match.index).trimEnd();
  return buttons.length
    ? { text: text || "Choose an option:", buttons }
    : { text: answer, buttons: [] };
}

export function keyboardFor(labels: string[]): InlineKeyboard {
  const rows: InlineKeyboard["inline_keyboard"] = [];
  for (let index = 0; index < labels.length; index += 2)
    rows.push(
      labels.slice(index, index + 2).map((label) => ({
        text: label,
        callback_data: PREFIX + label,
      })),
    );
  return { inline_keyboard: rows };
}

/** A pressed button becomes an ordinary message from the person who pressed it,
 * sent as a reply to the bot's message. Authorization is applied afterwards,
 * exactly as for typed text. Callers other than the plugin can offer the same
 * buttons by using `reply:<text>` as callback data. */
export function messageFromCallback(
  callback: TelegramCallbackQuery,
  botId: number,
): TelegramMessage | undefined {
  const source = callback.message;
  const data = callback.data;
  if (!source || !data?.startsWith(PREFIX)) return;
  const text = data.slice(PREFIX.length).trim();
  if (!text) return;
  return {
    message_id: source.message_id,
    ...(source.message_thread_id
      ? { message_thread_id: source.message_thread_id }
      : {}),
    date: source.date,
    chat: source.chat,
    from: callback.from,
    text,
    reply_to_message: {
      message_id: source.message_id,
      from: { id: botId, is_bot: true },
    },
  };
}
