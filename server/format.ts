import { Lexer, type Token, type MarkedToken } from "marked";
import { decodeHTML } from "entities/decode";

type EntityType = "bold" | "italic" | "strikethrough" | "code" | "pre" | "text_link" | "blockquote";
export interface TextEntity { type: EntityType; offset: number; length: number; url?: string; language?: string }
export interface TelegramText { text: string; entities: TextEntity[] }
const STYLES = new Set<EntityType>(["bold", "italic", "strikethrough"]);

/** Build text and UTF-16 spans directly; never send model HTML or parse_mode. */
class Writer {
  text = "";
  entities: TextEntity[] = [];
  add(text: string): void { this.text += text; }
  trimEnd(): void { this.text = this.text.trimEnd(); }
  span(type: EntityType, write: () => void, extra: { url?: string; language?: string } = {}): void {
    const start = this.text.length;
    const index = this.entities.length;
    write();
    let ranges = [{ start, end: this.text.trimEnd().length }];
    // Telegram forbids style/code overlap and nested non-style entities.
    const blockers = this.entities.slice(index).filter(entity => STYLES.has(type)
      ? entity.type === "code" || entity.type === "pre" : !STYLES.has(entity.type));
    for (const blocker of blockers) {
      const end = blocker.offset + blocker.length;
      ranges = ranges.flatMap(range => end <= range.start || blocker.offset >= range.end ? [range]
        : [{ start: range.start, end: Math.min(range.end, blocker.offset) }, { start: Math.max(range.start, end), end: range.end }].filter(part => part.end > part.start));
    }
    for (const range of ranges) if (range.end > range.start) this.entities.push({ type, offset: range.start, length: range.end - range.start, ...extra });
  }
}

function safeUrl(href: string): string | undefined {
  if (/[\s\x00-\x1f\x7f]/.test(href)) return;
  try {
    const url = new URL(href);
    if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) return href;
  } catch { /* Relative repository paths stay visible, but are not Telegram links. */ }
}

function render(tokens: Token[], out: Writer, depth = 0, compact = false): void {
  for (const value of tokens) {
    const token = value as MarkedToken;
    switch (token.type) {
      case "strong": out.span("bold", () => render(token.tokens, out, depth, compact)); break;
      case "em": out.span("italic", () => render(token.tokens, out, depth, compact)); break;
      case "del": out.span("strikethrough", () => render(token.tokens, out, depth, compact)); break;
      case "codespan": out.span("code", () => out.add(token.text)); break;
      case "code": {
        const language = token.lang?.split(/\s/)[0];
        out.span("pre", () => out.add(token.text), language && /^[\w+#.-]{1,40}$/.test(language) ? { language } : {});
        out.add("\n\n"); break;
      }
      case "heading": out.span("bold", () => render(token.tokens, out, depth)); out.add("\n\n"); break;
      case "paragraph": render(token.tokens, out, depth, compact); out.add(compact ? "\n" : "\n\n"); break;
      case "blockquote": out.span("blockquote", () => render(token.tokens, out, depth, compact)); out.trimEnd(); out.add("\n\n"); break;
      case "list": {
        if (out.text && !out.text.endsWith("\n")) out.add("\n");
        token.items.forEach((item, index) => {
          out.add(`${"  ".repeat(depth)}${item.task ? "" : token.ordered ? `${Number(token.start) + index}. ` : "• "}`);
          render(item.tokens, out, depth + 1, true);
          out.trimEnd(); out.add("\n");
        });
        out.add("\n"); break;
      }
      case "table": {
        // Vertical records fit phones; Telegram has no native table entity.
        if (!token.rows.length) { token.header.forEach((cell, index) => { if (index) out.add(" · "); render(cell.tokens, out); }); out.add("\n\n"); }
        for (const row of token.rows) {
          row.forEach((cell, index) => {
            const header = token.header[index];
            if (header?.text) { out.span("bold", () => render(header.tokens, out)); out.add(": "); }
            render(cell.tokens, out); out.add("\n");
          });
          out.add("\n");
        }
        break;
      }
      case "link": case "image": {
        const href = token.type === "link" && token.autolink ? token.href : decodeHTML(token.href);
        const url = safeUrl(href);
        const label = () => token.type === "link" && token.autolink ? out.add(token.text)
          : token.tokens.length ? render(token.tokens, out, depth, compact) : out.add(token.text || href);
        if (url) out.span("text_link", label, { url });
        else {
          label();
          if (/^(?:\.?\.?\/|file:)/.test(href) && href !== token.text) { out.add(" ("); out.span("code", () => out.add(href)); out.add(")"); }
        }
        break;
      }
      case "text": if (token.tokens) render(token.tokens, out, depth, compact); else out.add(decodeHTML(token.text)); break;
      case "escape": out.add(token.text); break;
      case "html": out.add(token.text); break; // Literal text, never executable markup.
      case "br": out.add("\n"); break;
      case "hr": out.add("────────\n\n"); break;
      case "space": if (out.text && !out.text.endsWith("\n\n")) out.add("\n"); break;
      case "checkbox": out.add(token.checked ? "☑ " : "☐ "); break;
      case "def": break;
      default: out.add(value.raw);
    }
  }
}

function clip(entities: TextEntity[], start: number, end: number): TextEntity[] {
  const seen = new Set<string>();
  const clipped = entities.flatMap(entity => {
    const from = Math.max(start, entity.offset);
    const to = Math.min(end, entity.offset + entity.length);
    return to > from ? [{ ...entity, offset: from - start, length: to - from }] : [];
  });
  const boundaries = [...new Set(clipped.filter(entity => !STYLES.has(entity.type)).flatMap(entity => [entity.offset, entity.offset + entity.length]))].sort((a, b) => a - b);
  return clipped.flatMap(entity => {
    if (!STYLES.has(entity.type)) return [entity];
    // Quote/link boundaries can cut through an outer style after code is excluded.
    const points = [entity.offset, ...boundaries.filter(point => point > entity.offset && point < entity.offset + entity.length), entity.offset + entity.length];
    return points.slice(0, -1).map((offset, index) => ({ ...entity, offset, length: points[index + 1] - offset }));
  }).sort((a, b) => a.offset - b.offset || b.length - a.length).filter(entity => {
    const key = JSON.stringify(entity);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Split rendered text, not Markdown syntax; clip every span into each part. */
export function formatReply(markdown: string, limit = 3800): TelegramText[] {
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 4096) throw new Error("Invalid Telegram text limit");
  const out = new Writer();
  render(Lexer.lex(markdown, { gfm: true, breaks: false }), out);
  out.trimEnd();
  if (!out.text.trim()) out.text = markdown.trim() || "…";
  const result: TelegramText[] = [];
  for (let start = 0; start < out.text.length;) {
    let end = Math.min(start + limit, out.text.length);
    if (end < out.text.length) {
      const line = out.text.lastIndexOf("\n", end - 1) + 1;
      const space = out.text.lastIndexOf(" ", end - 1) + 1;
      const boundary = line > start + limit * 0.6 ? line : space;
      if (boundary > start + limit * 0.6) end = boundary;
      if (/[\uDC00-\uDFFF]/.test(out.text[end])) end--;
    }
    // Keep each request modest even for answers with hundreds of tiny spans.
    const text = out.text.slice(start, end);
    if (text.trim()) result.push({ text, entities: clip(out.entities, start, end).slice(0, 90) });
    start = end;
  }
  return result;
}
