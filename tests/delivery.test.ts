import assert from "node:assert/strict";
import { test } from "node:test";
import { withRetry } from "../server/delivery.ts";
import { TelegramError, TelegramNetworkError } from "../server/telegram.ts";

const signal = new AbortController().signal;
const wait = async () => {};

function flaky(errors: Error[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: async () => {
      const error = errors[calls++];
      if (error) throw error;
      return "ok";
    },
  };
}

test("an idempotent step is retried after an uncertain failure", async () => {
  const step = flaky([new TelegramNetworkError("uncertain"), new TelegramNetworkError("uncertain")]);
  assert.equal(await withRetry(step.run, () => true, signal, wait), "ok");
  assert.equal(step.calls, 3);
});

test("a new message is not resent after an uncertain failure", async () => {
  const step = flaky([new TelegramNetworkError("uncertain")]);
  await assert.rejects(withRetry(step.run, () => false, signal, wait));
  assert.equal(step.calls, 1);
});

test("a new message is retried when it provably was not sent", async () => {
  const step = flaky([new TelegramNetworkError("unreachable"), new TelegramError(502)]);
  assert.equal(await withRetry(step.run, () => false, signal, wait), "ok");
  assert.equal(step.calls, 3);
});

test("permanent errors and exhausted retries are thrown", async () => {
  const rejected = flaky([new TelegramError(400)]);
  await assert.rejects(withRetry(rejected.run, () => true, signal, wait));
  assert.equal(rejected.calls, 1);
  const down = flaky(Array.from({ length: 10 }, () => new TelegramNetworkError("unreachable")));
  await assert.rejects(withRetry(down.run, () => false, signal, wait, [1, 2]));
  assert.equal(down.calls, 3);
});

test("retrying stops when the receiver is stopped", async () => {
  const controller = new AbortController();
  controller.abort();
  const step = flaky([new TelegramNetworkError("unreachable")]);
  await assert.rejects(withRetry(step.run, () => true, controller.signal, wait));
  assert.equal(step.calls, 1);
});
