import assert from "node:assert/strict";
import { test } from "node:test";
import { extractButtons, keyboardFor, messageFromCallback } from "../server/buttons.ts";

test("button marker is removed from the text", () => {
  assert.deepEqual(extractButtons("Ready to push.\n\n[buttons: OK push | Clore]\n"), {
    text: "Ready to push.",
    buttons: ["OK push", "Clore"],
  });
  assert.deepEqual(extractButtons("No buttons here"), { text: "No buttons here", buttons: [] });
  assert.deepEqual(extractButtons("[buttons: only]"), { text: "Choose an option:", buttons: ["only"] });
});

test("marker in the middle, oversized or duplicate labels are handled", () => {
  const middle = "[buttons: A | B]\nand then more text";
  assert.deepEqual(extractButtons(middle), { text: middle, buttons: [] });
  const long = "x".repeat(70);
  assert.deepEqual(extractButtons(`Hi\n[buttons: ${long} | A | A]`), { text: "Hi", buttons: ["A"] });
  const many = extractButtons("Hi\n[buttons: 1|2|3|4|5|6|7|8]");
  assert.equal(many.buttons.length, 6);
  assert.deepEqual(extractButtons("Hi [buttons: A]"), { text: "Hi [buttons: A]", buttons: [] });
});

test("keyboard puts two buttons per row with reply: data", () => {
  const keyboard = keyboardFor(["A", "B", "C"]);
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, "reply:B");
});

test("a press becomes a reply from the presser", () => {
  const message = messageFromCallback(
    {
      id: "cb",
      from: { id: 42 },
      data: "reply:OK push",
      message: { message_id: 9, message_thread_id: 3, date: 5, chat: { id: -1, type: "supergroup" } },
    },
    777,
  );
  assert.equal(message?.text, "OK push");
  assert.equal(message?.from?.id, 42);
  assert.equal(message?.message_thread_id, 3);
  assert.equal(message?.reply_to_message?.from?.id, 777);
  assert.equal(
    messageFromCallback({ id: "x", from: { id: 1 }, data: "other", message: undefined }, 1),
    undefined,
  );
  assert.equal(
    messageFromCallback(
      { id: "x", from: { id: 1 }, data: "reply:", message: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } },
      1,
    ),
    undefined,
  );
});
