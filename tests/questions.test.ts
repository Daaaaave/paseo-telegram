import test from "node:test";
import assert from "node:assert/strict";
import {
  questionAnswers,
  questionFrom,
  questionText,
  waitForAnswerTurn,
  waitForTask,
} from "../server/questions.ts";

const permission = {
  id: "question-1",
  provider: "codex",
  kind: "question",
  name: "request_user_input_async",
  input: {
    questions: [
      {
        header: "Question 1",
        question: "Как добавить LoRA?",
        options: [{ label: "Импорт" }, { label: "Загрузка" }],
      },
    ],
  },
} as Parameters<typeof questionFrom>[0];

test("native question forms become replyable Telegram text with exact option/header mapping", () => {
  const question = questionFrom(permission)!;
  assert.match(questionText(question), /Как добавить LoRA\?/);
  assert.match(questionText(question), /2\) Загрузка/);
  assert.match(questionText(question), /^Clarification:/);
  assert.match(
    questionText(question),
    /Reply to this message with an option number/,
  );
  assert.deepEqual(questionAnswers(question, "2"), {
    "Question 1": "Загрузка",
  });
  assert.deepEqual(questionAnswers(question, "Своим способом"), {
    "Question 1": "Своим способом",
  });
  assert.equal(questionAnswers(question, "8"), undefined);
  const multiple = {
    ...question,
    fields: [
      ...question.fields,
      { header: "Size", text: "Размер?", options: [] },
    ],
  };
  assert.match(questionText(multiple), /one answer per line/);
  assert.deepEqual(questionAnswers(multiple, "1: 1\n2: 512"), {
    "Question 1": "Импорт",
    Size: "512",
  });
  assert.equal(questionAnswers(multiple, "1: 1"), undefined);
  assert.equal(questionFrom({ ...permission, kind: "tool" }), undefined);
});

test("an async question does not end waiting until the foreground turn really finishes", async () => {
  let calls = 0;
  let pauses = 0;
  const agent = {
    waitForFinish: async () => {
      calls++;
      return {
        status: "permission",
        final: {
          status: calls < 3 ? "running" : "idle",
          activeTurn: calls < 3 ? { turnId: "turn" } : null,
          pendingPermissions: [permission],
        },
        lastMessage:
          calls < 3 ? "Intermediate commentary" : "Actual final answer",
        error: null,
      };
    },
  } as unknown as Parameters<typeof waitForTask>[0];
  const result = await waitForTask(
    agent,
    new AbortController().signal,
    async (ms) => {
      assert.equal(ms, 1000);
      pauses++;
    },
  );
  assert.equal(result.status, "idle");
  assert.equal(result.lastMessage, "Actual final answer");
  assert.equal(pauses, 2);
});

test("blocking questions and real permission requests return attention without being approved", async () => {
  for (const request of [
    { ...permission, name: "request_user_input" },
    { ...permission, kind: "tool", name: "shell" },
  ]) {
    const agent = {
      waitForFinish: async () => ({
        status: "permission",
        final: {
          status: "running",
          activeTurn: { turnId: "turn" },
          pendingPermissions: [request],
        },
      }),
    } as unknown as Parameters<typeof waitForTask>[0];
    assert.equal(
      (
        await waitForTask(agent, new AbortController().signal, async () =>
          assert.fail("must not spin"),
        )
      ).status,
      "permission",
    );
  }
});

test("an approval handler keeps a tool permission attached until the original task finishes", async () => {
  let calls = 0, notices = 0;
  const agent = { waitForFinish: async () => ({
    status: ++calls < 3 ? "permission" : "idle",
    final: { status: calls < 3 ? "running" : "idle", activeTurn: calls < 3 ? {} : null,
      pendingPermissions: calls < 3 ? [{ ...permission, kind: "tool", name: "sql" }] : [] },
    lastMessage: calls < 3 ? "Waiting" : "Final report",
  }) } as unknown as Parameters<typeof waitForTask>[0];
  const result = await waitForTask(agent, new AbortController().signal, async () => {}, undefined, new Set(), async (requests) => {
    assert.equal(requests[0].name, "sql"); notices++;
  });
  assert.equal(result.status, "idle"); assert.equal(result.lastMessage, "Final report"); assert.equal(notices, 2);
});

test("a permission attention event without its native details cannot finalize the task", async () => {
  let calls = 0;
  const agent = { waitForFinish: async () => ++calls === 1
    ? { status: "permission", final: { status: "running", pendingPermissions: [] } }
    : { status: "idle", lastMessage: "Final answer", final: { status: "idle", pendingPermissions: [] } },
  } as unknown as Parameters<typeof waitForTask>[0];
  const result = await waitForTask(agent, new AbortController().signal, async () => {}, undefined, new Set(), async () => {});
  assert.equal(result.status, "idle"); assert.equal(result.lastMessage, "Final answer");
});

test("an async answer waits for its scheduled follow-up instead of returning the previous final answer", async () => {
  let calls = 0;
  let pauses = 0;
  const agent = {
    timeline: {
      refetch: async () => ({
        epoch: "epoch",
        entries:
          ++calls < 3
            ? [
                {
                  seqEnd: 10,
                  item: { type: "assistant_message", text: "Previous final" },
                },
                { seqEnd: 11, item: { type: "tool_call" } },
              ]
            : [
                {
                  seqEnd: 12,
                  item: {
                    type: "user_message",
                    text: "Answers to your questions",
                  },
                },
              ],
      }),
    },
  } as unknown as Parameters<typeof waitForAnswerTurn>[0];
  await waitForAnswerTurn(
    agent,
    { epoch: "epoch", seq: 10 },
    new AbortController().signal,
    async () => {
      pauses++;
    },
  );
  assert.equal(pauses, 2);
  assert.equal(calls, 3);
});
