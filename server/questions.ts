import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { Question } from "./store.ts";
import { pause } from "./telegram.ts";

type Agent = ReturnType<PluginHookContext["paseo"]["agents"]["ref"]>;
type Result = Awaited<ReturnType<Agent["waitForFinish"]>>;
type Permission = NonNullable<NonNullable<Result["final"]>["pendingPermissions"]>[number];

export function questionFrom(request: Permission): Question | undefined {
  if (request.kind !== "question" || !Array.isArray(request.input?.questions)) return;
  const fields = request.input.questions.flatMap(value => {
    if (!value || typeof value !== "object" || typeof value.header !== "string" || typeof value.question !== "string") return [];
    const options = Array.isArray(value.options) ? value.options.flatMap((option: unknown) => option && typeof option === "object" && "label" in option && typeof option.label === "string" ? [option.label] : []) : [];
    return [{ header: value.header, text: value.question, options }];
  });
  if (!fields.length || fields.length !== request.input.questions.length || new Set(fields.map(field => field.header)).size !== fields.length) return;
  return { requestId: request.id, fields, status: "pending" };
}

export function questionText(question: Question, russian: boolean): string {
  const body = question.fields.map((field, index) => `${question.fields.length > 1 ? `${index + 1}. ` : ""}${field.text}${field.options.length ? `\n${field.options.map((option, i) => `  ${i + 1}) ${option}`).join("\n")}` : ""}`).join("\n\n");
  const instruction = question.fields.length === 1
    ? russian ? "Ответьте на это сообщение номером варианта или своим текстом." : "Reply to this message with an option number or your own text."
    : russian ? "Ответьте на это сообщение, указав каждый ответ отдельной строкой: 1: ответ, 2: ответ." : "Reply to this message with one answer per line: 1: answer, 2: answer.";
  return `${russian ? "Уточняющий вопрос:" : "Clarification:"}\n\n${body}\n\n${instruction}`;
}

export function questionAnswers(question: Question, text: string): Record<string, string> | undefined {
  const values = question.fields.length === 1 ? [text.trim()] : question.fields.map((_, index) => {
    const matches = text.split("\n").map(line => new RegExp(`^\\s*${index + 1}\\s*[:.)]\\s*(.+)$`).exec(line)).filter(Boolean);
    return matches.length === 1 ? matches[0]![1].trim() : "";
  });
  if (values.some(value => !value)) return;
  const entries = question.fields.map((field, index) => {
    const number = field.options.length && /^\d+$/.test(values[index]) ? Number(values[index]) : NaN;
    if (Number.isFinite(number) && (number < 1 || number > field.options.length)) return;
    return [field.header, Number.isFinite(number) ? field.options[number - 1] : values[index]] as const;
  });
  return entries.every(entry => entry !== undefined) ? Object.fromEntries(entries) : undefined;
}

/** Async questions are session attention, not the end of a foreground turn. */
export async function waitForTask(agent: Agent, signal: AbortSignal, wait = pause, onAsyncQuestion?: (question: Question) => Promise<void>): Promise<Result> {
  while (!signal.aborted) {
    const result = await abortable(agent.waitForFinish(60_000), signal);
    if (result.status === "timeout") continue;
    if (result.status !== "permission") return result;
    const permissions = result.final?.pendingPermissions ?? [];
    const blocking = permissions.some(request => request.kind !== "question" || request.name !== "request_user_input_async");
    if (blocking || !permissions.length) return result;
    if (result.final?.status === "idle" && !result.final.activeTurn) return { ...result, status: "idle" };
    if (result.final?.status === "error") return { ...result, status: "error" };
    const question = permissions.map(questionFrom).find(value => value !== undefined);
    if (question && onAsyncQuestion) await onAsyncQuestion(question);
    // Repeated waits otherwise resolve immediately to the same outstanding form.
    await wait(1000, signal);
  }
  throw new Error("Support receiver reloaded");
}

/** Permission RPC acknowledgement precedes scheduling an idle agent's follow-up. */
export async function waitForAnswerTurn(agent: Agent, after: { epoch: string; seq: number }, signal: AbortSignal, wait = pause): Promise<void> {
  while (!signal.aborted) {
    const timeline = await agent.timeline.refetch({ limit: 30 });
    if (timeline.epoch !== after.epoch) throw new Error("Question follow-up timeline changed; inspect its Paseo chat");
    if (timeline.entries.some(entry => entry.seqEnd > after.seq && entry.item.type === "user_message")) return;
    await wait(250, signal);
  }
  throw new Error("Support receiver reloaded");
}

export function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Telegram receiver stopped"));
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
  });
}
