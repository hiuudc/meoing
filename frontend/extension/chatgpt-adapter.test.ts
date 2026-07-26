// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalPreviewLesson } from "../src/learning/demoLesson";
import { DEFAULT_LEARNING_PROFILE } from "../src/learning/profile";
import { LESSON_QUESTION_FORMATS, type LessonQuestion } from "../src/learning/types";
import type { ChatOperationKind, OperationExpectation } from "../src/integration/protocol";
import {
  CHAT_RESULT_MAX_BYTES,
  assistantTurnText,
  composerTextMatchesExpected,
  composerTextMismatchSummary,
  currentComposer,
  findAssistantTurns,
  findComposer,
  findSendButton,
  parseChatOperationResult,
  quotaReached,
  repairAttemptNumbers,
  responseGenerationActive,
  resultParseFailureReason,
} from "./chatgpt-adapter";

const expectation: OperationExpectation = {
  unitId: "unit-1",
  targetLanguage: "English",
  sourceLanguage: "Vietnamese",
  level: "elementary",
  questionCount: 15,
  speaking: true,
  allowedFormats: [...LESSON_QUESTION_FORMATS],
};

function generatedPreviewLesson() {
  const lesson = createLocalPreviewLesson("unit-1", "ignored", {
    ...DEFAULT_LEARNING_PROFILE,
    targetLanguage: expectation.targetLanguage,
    sourceLanguage: "Vietnamese",
  });
  const selectedQuestions = [
    ...lesson.questions.slice(0, expectation.questionCount - 2),
    lesson.questions.find((question) => question.type === "speakingRepeat")!,
    lesson.questions.find((question) => question.type === "speakingRoleplay")!,
  ];
  const questions = selectedQuestions.map((question) => {
    const { presentation: _presentation, ...generatedQuestion } = question;
    return generatedQuestion as LessonQuestion;
  });
  const primaryIds = new Set(questions.map((question) => question.id));
  return {
    ...lesson,
    questions,
    questionAlternates: lesson.questionAlternates
      ?.filter((alternate) => primaryIds.has(alternate.questionId))
      .map((alternate) => {
        const { presentation: _presentation, ...generatedQuestion } = alternate.question;
        return { ...alternate, question: generatedQuestion as LessonQuestion };
      }),
  };
}

function parse(text: string, operationId = "op-1", kind: ChatOperationKind = "coaching", expected = expectation) {
  return parseChatOperationResult(text, operationId, kind, expected);
}

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { width: 120, height: 40, top: 0, right: 120, bottom: 40, left: 0, x: 0, y: 0, toJSON() {} }; },
  });
});

describe("ChatGPT selector adapter", () => {
  it("prefers data-testid and refuses an ambiguous fallback", () => {
    document.body.innerHTML = '<form><div contenteditable="true"></div><textarea data-testid="prompt-textarea"></textarea></form>';
    expect(findComposer()).toBe(document.querySelector("textarea"));
    document.body.innerHTML = '<form><div contenteditable="true"></div><textarea></textarea></form>';
    expect(findComposer()).toBeNull();
  });

  it("uses an accessible composer and enabled Send control", () => {
    document.body.innerHTML = '<form><div id="composer" role="textbox" contenteditable="true" aria-label="Message ChatGPT"></div><button aria-label="Send prompt">Send</button></form>';
    const composer = findComposer();
    expect(composer?.id).toBe("composer");
    expect(findSendButton(composer!)).toBe(document.querySelector("button"));
    document.querySelector("button")!.setAttribute("aria-disabled", "true");
    expect(findSendButton(composer!)).toBeNull();
  });

  it("prefers the current ChatGPT ProseMirror composer over its fallback textarea", () => {
    document.body.innerHTML = `
      <form>
        <textarea aria-label="Chat with ChatGPT" class="fallback"></textarea>
        <div id="prompt-textarea" role="textbox" contenteditable="true" aria-label="Chat with ChatGPT"></div>
      </form>
    `;
    expect(findComposer()).toBe(document.querySelector("#prompt-textarea"));
  });

  it("reacquires the live composer after ChatGPT replaces the original node", () => {
    document.body.innerHTML = '<form><div id="prompt-textarea" contenteditable="true">old</div></form>';
    const stale = findComposer()!;
    document.querySelector("form")!.innerHTML = '<div id="prompt-textarea" contenteditable="true">new</div>';
    const live = document.querySelector<HTMLElement>("#prompt-textarea")!;

    expect(stale.isConnected).toBe(false);
    expect(currentComposer(stale)).toBe(live);
  });

  it("verifies exact composer text across ProseMirror whitespace rendering", () => {
    expect(composerTextMatchesExpected("Task\n\nCreate a lesson\u00a0now", "Task\nCreate   a lesson now")).toBe(true);
    expect(composerTextMatchesExpected("Task\u200B now", "Task now")).toBe(true);
    expect(composerTextMatchesExpected("Task: create a lesson", "Task: evaluate an answer")).toBe(false);
    expect(composerTextMismatchSummary("Task now", "Task later")).toBe("actual normalized length 8, expected 10, first difference at 5");
  });

  it("detects quota only from error controls, not conversation content", () => {
    document.body.innerHTML = '<article class="assistant-message">You reached the quota in this example sentence.</article>';
    expect(quotaReached()).toBe(false);
    document.body.insertAdjacentHTML("beforeend", '<div role="alert">You have reached your Free plan limit. Try again later.</div>');
    expect(quotaReached()).toBe(true);
  });

  it("finds only explicitly marked assistant turns and retains surrounding commentary", () => {
    document.body.innerHTML = `
      <article data-message-author-role="user">old user text</article>
      <article data-message-author-role="assistant" id="old">old assistant</article>
      <article data-message-author-role="assistant" id="new"><div class="markdown"><p>Done</p><pre><code class="language-json">{"ok":true}</code></pre></div></article>
    `;
    const turns = findAssistantTurns();
    expect(turns.map((turn) => turn.id)).toEqual(["old", "new"]);
    expect(assistantTurnText(turns[1])).toContain("Done");
    expect(assistantTurnText(turns[1])).toContain("```json");
  });

  it("uses an explicit conversation-turn fallback and detects streaming completion", () => {
    document.body.innerHTML = `
      <article data-testid="conversation-turn-4" data-turn="assistant">result</article>
      <button data-testid="stop-button">Stop</button>
    `;
    expect(findAssistantTurns()).toHaveLength(1);
    expect(responseGenerationActive()).toBe(true);
    document.querySelector("button")!.setAttribute("style", "display:none");
    expect(responseGenerationActive()).toBe(false);
  });
});

describe("strict ChatGPT result parsing", () => {
  const raw = '{"type":"meoi.operation.result","protocolVersion":8,"operationId":"op-1","kind":"coaching","outcome":"completed","result":{"coachingReply":"Try again."}}';

  it("parses exact raw JSON or one standalone json fence", () => {
    expect(parse(raw)).toMatchObject({ ok: true, result: { protocolVersion: 8, operationId: "op-1" } });
    expect(parse(`\`\`\`json\n${raw}\n\`\`\``).ok).toBe(true);
    document.body.innerHTML = `<div data-message-author-role="assistant"><pre><code>${raw}</code></pre></div>`;
    expect(parse(assistantTurnText(findAssistantTurns()[0])).ok).toBe(true);
  });

  it("rejects commentary around a fence and multiple JSON blocks", () => {
    expect(parse(`Done\n\`\`\`json\n${raw}\n\`\`\``)).toMatchObject({ ok: false, code: "AMBIGUOUS_JSON_BLOCK" });
    expect(parse('```json\n{}\n```\n```json\n{}\n```')).toMatchObject({ ok: false, code: "AMBIGUOUS_JSON_BLOCK" });
  });

  it("allows exactly three repair follow-ups after the first response", () => {
    expect(repairAttemptNumbers()).toEqual([1, 2, 3]);
  });

  it("accepts needs_source and strict structured failures", () => {
    const needsSource = '{"type":"meoi.operation.result","protocolVersion":8,"operationId":"op-1","kind":"create_lesson","outcome":"needs_source","result":{"sourceRequest":"Paste a transcript."}}';
    const failed = '{"type":"meoi.operation.result","protocolVersion":8,"operationId":"op-2","kind":"evaluate_answer","outcome":"failed","error":{"code":"NO_ANSWER","message":"No answer was supplied."}}';
    expect(parse(needsSource, "op-1", "create_lesson").ok).toBe(true);
    expect(parse(failed, "op-2", "evaluate_answer").ok).toBe(true);
  });

  it("deeply validates a lesson against the expected unit and profile", () => {
    const lesson = generatedPreviewLesson();
    const valid = JSON.stringify({
      type: "meoi.operation.result",
      protocolVersion: 8,
      operationId: "op-1",
      kind: "create_lesson",
      outcome: "completed",
      result: { lesson },
    });
    const parsedValid = parse(valid, "op-1", "create_lesson");
    expect(parsedValid.ok, parsedValid.ok ? "" : resultParseFailureReason(parsedValid)).toBe(true);

    const wrongUnit = JSON.stringify({
      ...JSON.parse(valid),
      result: { lesson: { ...lesson, unitId: "unit-2" } },
    });
    const parsed = parse(wrongUnit, "op-1", "create_lesson");
    expect(parsed).toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });
    if (!parsed.ok) expect(resultParseFailureReason(parsed)).toContain("lesson.unitId");

    const disabledFormatExpectation = {
      ...expectation,
      allowedFormats: LESSON_QUESTION_FORMATS.filter((format) => format !== "singleChoice"),
    };
    expect(parse(valid, "op-1", "create_lesson", disabledFormatExpectation)).toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });

    const locallyDecorated = {
      ...lesson,
      questions: lesson.questions.map((question, index) => index === 0
        ? { ...question, presentation: { readQuestion: true, readAnswers: true, wordTooltips: true } }
        : question),
    };
    const untrustedPresentation = JSON.stringify({
      ...JSON.parse(valid),
      result: { lesson: locallyDecorated },
    });
    expect(parse(untrustedPresentation, "op-1", "create_lesson")).toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });
  });

  it("rejects removed blueprint metadata", () => {
    const lesson = generatedPreviewLesson();
    const envelope = (candidate: typeof lesson) => JSON.stringify({
      type: "meoi.operation.result",
      protocolVersion: 8,
      operationId: "op-1",
      kind: "create_lesson",
      outcome: "completed",
      result: { lesson: candidate },
    });
    const generatedWithTemplateId = {
      ...lesson,
      questions: lesson.questions.map((question, index) => (
        index === 0 ? { ...question, templateId: "removed-blueprint" } : question
      )),
    };
    expect(parse(envelope(generatedWithTemplateId), "op-1", "create_lesson"))
      .toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });
  });

  it("rejects disabled alternate formats, alternate extras, and missing glossary coverage", () => {
    const lesson = generatedPreviewLesson();
    const envelope = (candidate: typeof lesson) => JSON.stringify({
      type: "meoi.operation.result",
      protocolVersion: 8,
      operationId: "op-1",
      kind: "create_lesson",
      outcome: "completed",
      result: { lesson: candidate },
    });
    const disabledAlternateExpectation: OperationExpectation = {
      ...expectation,
      allowedFormats: LESSON_QUESTION_FORMATS.filter((format) => format !== "fillBlank"),
    };
    expect(parse(envelope(lesson), "op-1", "create_lesson", disabledAlternateExpectation))
      .toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });

    const alternateTemplate = {
      ...lesson,
      questionAlternates: lesson.questionAlternates?.map((alternate, index) => index === 0
        ? { ...alternate, question: { ...alternate.question, templateId: "not-allowed" } }
        : alternate),
    };
    expect(parse(envelope(alternateTemplate), "op-1", "create_lesson"))
      .toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });

    const missingCoverage = {
      ...lesson,
      questions: lesson.questions.map((question, index) => index === 0 ? { ...question, glossaryTargets: [] } : question),
    };
    expect(parse(envelope(missingCoverage), "op-1", "create_lesson"))
      .toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });
  });

  it("deeply validates evaluation fields and rejects extras", () => {
    const evaluation = {
      status: "partial",
      score: 0.5,
      correctParts: ["Greeting"],
      errors: [{ location: "verb", message: "Use present tense." }],
      correction: "I work here.",
      explanation: "This describes a current fact.",
      nextHint: "Check the verb.",
    };
    const envelope = (value: unknown) => JSON.stringify({
      type: "meoi.operation.result", protocolVersion: 8, operationId: "op-1", kind: "evaluate_answer", outcome: "completed", result: { evaluation: value },
    });
    expect(parse(envelope(evaluation), "op-1", "evaluate_answer").ok).toBe(true);
    expect(parse(envelope({ ...evaluation, saved: true }), "op-1", "evaluate_answer")).toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });
  });

  it("rejects wrong IDs, kinds, extra envelope fields, and oversized responses", () => {
    const wrong = '{"type":"meoi.operation.result","protocolVersion":8,"operationId":"op-2","kind":"coaching","outcome":"completed","result":{"coachingReply":"ok"}}';
    expect(parse(wrong, "op-1", "coaching")).toMatchObject({ ok: false, code: "WRONG_OPERATION_ID" });
    expect(parse(wrong, "op-2", "create_lesson")).toMatchObject({ ok: false, code: "WRONG_OPERATION_KIND" });
    expect(parse('{"type":"meoi.operation.result","protocolVersion":8,"operationId":"op-1","kind":"coaching","outcome":"completed","result":{"coachingReply":"ok"},"extra":true}'))
      .toMatchObject({ ok: false, code: "INVALID_RESULT_SCHEMA" });
    expect(parse("x".repeat(CHAT_RESULT_MAX_BYTES + 1))).toMatchObject({ ok: false, code: "RESPONSE_TOO_LARGE" });
  });
});
