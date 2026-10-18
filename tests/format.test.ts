import test from "node:test";
import assert from "node:assert/strict";
import { formatReply, type TelegramText } from "../server/format.ts";

function spans(content: TelegramText, type: string): string[] {
  return content.entities.filter(entity => entity.type === type).map(entity => content.text.slice(entity.offset, entity.offset + entity.length));
}
function valid(content: TelegramText, limit = 3800): void {
  assert.ok(content.text.trim());
  assert.ok(content.text.length <= limit);
  assert.ok(content.entities.length <= 90);
  for (const a of content.entities) {
    assert.ok(a.offset >= 0 && a.length > 0 && a.offset + a.length <= content.text.length);
    assert.doesNotMatch(content.text[a.offset], /[\uDC00-\uDFFF]/);
    for (const b of content.entities) {
      if (a === b || a.offset + a.length <= b.offset || b.offset + b.length <= a.offset) continue;
      assert.ok((a.offset <= b.offset && a.offset + a.length >= b.offset + b.length) || (b.offset <= a.offset && b.offset + b.length >= a.offset + a.length), "entities must not cross");
      if ([a.type, b.type].some(type => type === "code" || type === "pre")) assert.fail("code/pre cannot overlap other entities");
      assert.ok([a.type, b.type].some(type => ["bold", "italic", "strikethrough"].includes(type)), "non-style entities cannot contain each other");
    }
  }
}

test("the reported LoRA reply renders emphasis and code without Markdown delimiters", () => {
  const [content] = formatReply("**Триггер-слова LoRA нужно добавлять в `prompt` самостоятельно.** По текущему коду API, список `modelAssets` подключает LoRA.\n\nПоле `trainedWords` — подсказка.");
  assert.equal(content.text, "Триггер-слова LoRA нужно добавлять в prompt самостоятельно. По текущему коду API, список modelAssets подключает LoRA.\n\nПоле trainedWords — подсказка.");
  assert.deepEqual(spans(content, "code"), ["prompt", "modelAssets", "trainedWords"]);
  assert.match(spans(content, "bold").join(""), /Триггер-слова LoRA/);
  valid(content);
});

test("headings, nested lists, tasks, quotes, links and fenced code retain readable structure", () => {
  const [content] = formatReply("# Заголовок\n\n1. **Первый**\n   - Вложенный\n2. Второй\n\n- [x] Готово\n- [ ] Осталось\n\n> *Цитата* с [документацией](https://example.test/?a=1&b=2) и `кодом`\n\n```js\nconst x = '<b>&amp;</b>';\n```\n\n~~Устарело~~");
  assert.match(content.text, /^Заголовок\n\n1\. Первый\n  • Вложенный\n2\. Второй/);
  assert.match(content.text, /☑ Готово\n☐ Осталось/);
  assert.ok(spans(content, "blockquote").length);
  assert.deepEqual(spans(content, "italic"), ["Цитата"]);
  assert.deepEqual(spans(content, "strikethrough"), ["Устарело"]);
  assert.deepEqual(content.entities.filter(entity => entity.type === "text_link").map(entity => entity.url), ["https://example.test/?a=1&b=2"]);
  assert.deepEqual(spans(content, "pre"), ["const x = '<b>&amp;</b>';"]);
  assert.equal(content.entities.find(entity => entity.type === "pre")?.language, "js");
  valid(content);
});

test("tables become labeled records suitable for narrow screens", () => {
  const [content] = formatReply("| Модель | Цена |\n|---|---|\n| **Krea** | `2` |\n| Flux | 3 |");
  assert.equal(content.text, "Модель: Krea\nЦена: 2\n\nМодель: Flux\nЦена: 3");
  assert.deepEqual(spans(content, "code"), ["2"]);
  assert.ok(!content.text.includes("|"));
  valid(content);
});

test("literal HTML, special characters, escaped Markdown and unsafe links never become markup", () => {
  const [content] = formatReply("<b>literal</b> &amp; &lt;x&gt; \\*literal\\*\n\n[Bad](javascript:alert) [Local](/workspace/file.ts:12) [Mail](mailto:help@example.test)\n\n<https://example.test/?a=1&copy=2>");
  assert.match(content.text, /<b>literal<\/b> & <x> \*literal\*/);
  assert.match(content.text, /Bad Local \(\/workspace\/file.ts:12\)/);
  const urls = content.entities.filter(entity => entity.type === "text_link").map(entity => entity.url);
  assert.deepEqual(urls, ["mailto:help@example.test", "https://example.test/?a=1&copy=2"]);
  assert.ok(!urls.some(url => url?.startsWith("javascript:")));
  assert.ok(!spans(content, "bold").length);
  valid(content);
});

test("long formatted messages split after rendering with intact Unicode and local entity offsets", () => {
  const text = "🙂 Кириллица & <текст> ".repeat(500).trimEnd();
  const parts = formatReply(`**${text}**\n\n\`\`\`json\n${text}\n\`\`\``);
  assert.ok(parts.length > 2);
  assert.equal(parts.map(part => part.text).join(""), `${text}\n\n${text}`.trimEnd());
  for (const part of parts) valid(part);
  assert.ok(parts.some(part => part.entities.some(entity => entity.type === "bold")));
  assert.ok(parts.some(part => part.entities.some(entity => entity.type === "pre")));
});

test("incomplete streaming Markdown and dense formatting stay deliverable", () => {
  for (const text of ["Проверяю **код", "```js\nconst x = 1;", "", "[label](", "**a** ".repeat(1000), " ".repeat(5000) + "ok"]) {
    for (const part of formatReply(text)) valid(part);
  }
});

test("emphasis surrounding links inside a quote respects Telegram's nesting restrictions", () => {
  for (const input of ["> before **bold [link](https://example.test) after** tail", "> outer\n>\n> > nested **text**\n>\n> **more `code` text**", "# **heading** and `code`"]) {
    for (const part of formatReply(input)) valid(part);
  }
});
