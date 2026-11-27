import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FileTooLargeError,
  Telegram,
  TelegramNetworkError,
} from "../server/telegram.ts";

const TOKEN = "123456:SECRET_token-abc";
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });

function client(fileBody: () => Response, filePath = "photos/file_1.jpg", size?: number) {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    return url.includes("/file/bot")
      ? fileBody()
      : json({ ok: true, result: { file_path: filePath, file_size: size } });
  };
  return { urls, telegram: new Telegram(async () => TOKEN, fetcher) };
}

test("downloadFile stores the file and returns its size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-dl-"));
  const { telegram, urls } = client(() => new Response("hello"));
  const target = join(dir, "a.bin");
  assert.equal(await telegram.downloadFile("id", target, 100), 5);
  assert.equal(await readFile(target, "utf8"), "hello");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.ok(urls[1].endsWith("/file/bot123456:SECRET_token-abc/photos/file_1.jpg"));
});

test("downloadFile enforces the limit while streaming and leaves no file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-dl-"));
  const { telegram } = client(() => new Response("x".repeat(500)), "f/big.bin", 10);
  const target = join(dir, "b.bin");
  await assert.rejects(telegram.downloadFile("id", target, 100), FileTooLargeError);
  const lying = client(() => new Response("x".repeat(500)));
  await assert.rejects(lying.telegram.downloadFile("id", target, 100), FileTooLargeError);
  await assert.rejects(stat(target));
});

test("downloadFile rejects path traversal and never reveals the token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-dl-"));
  const traversal = client(() => new Response("x"), "../../etc/passwd");
  await assert.rejects(traversal.telegram.downloadFile("id", join(dir, "c"), 100));
  const failing = new Telegram(
    async () => TOKEN,
    async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    },
  );
  await assert.rejects(
    failing.call("getMe", {}),
    (error: Error) => error instanceof TelegramNetworkError && !error.message.includes("SECRET"),
  );
  const noBody = client(() => new Response(null, { status: 500 }));
  await assert.rejects(
    noBody.telegram.downloadFile("id", join(dir, "d"), 100),
    (error: Error) => !error.message.includes("SECRET"),
  );
});

test("network failures are classified by whether the request was sent", async () => {
  const refused = new Telegram(async () => TOKEN, async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  await assert.rejects(refused.call("getMe", {}), (error: TelegramNetworkError) => error.delivery === "unreachable");
  const timeout = new Telegram(async () => TOKEN, async () => {
    throw new DOMException("timed out", "TimeoutError");
  });
  await assert.rejects(timeout.call("getMe", {}), (error: TelegramNetworkError) => error.delivery === "uncertain");
});
