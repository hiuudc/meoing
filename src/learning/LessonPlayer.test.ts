// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonPlayer } from "./LessonPlayer";
import { LESSON_PLAYER_PREFERENCE_KEY } from "./playerPreferences";
import type { Lesson, LessonQuestion } from "./types";

const lesson: Lesson = {
  schemaVersion: 2,
  id: "player-test",
  unitId: "unit-test",
  title: "Player test",
  summary: "A compact player interaction fixture.",
  targetLanguage: "English",
  level: "elementary",
  objectives: ["Answer two questions"],
  theory: [{ id: "theory", kind: "concept", title: "Test theory", body: "Use the answer key." }],
  examples: [],
  glossary: [],
  sourceReferences: [],
  questions: [
    {
      id: "q1",
      type: "singleChoice",
      prompt: "Choose the first answer.",
      explanation: "A is the stored answer.",
      hint: "Choose A.",
      evaluationMode: "local",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      correctOptionId: "a",
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: false },
    },
    {
      id: "q2",
      type: "singleChoice",
      prompt: "Choose the second answer.",
      explanation: "C is the stored answer.",
      evaluationMode: "local",
      options: [{ id: "c", label: "C" }, { id: "d", label: "D" }],
      correctOptionId: "c",
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: false },
    },
  ],
  createdAt: "2026-07-20T00:00:00.000Z",
};

let root: Root | null = null;

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(label) || candidate.getAttribute("aria-label") === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function renderPlayer(overrides: Partial<Parameters<typeof LessonPlayer>[0]> = {}) {
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div><aside id="background">Background</aside></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(LessonPlayer, {
      lesson,
      coachingAvailable: false,
      onExit: vi.fn(),
      ...overrides,
    }));
  });
}

async function selectAnswer(value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[value="${value}"]`);
  if (!input) throw new Error(`Answer not found: ${value}`);
  await act(async () => input.click());
}

async function setTextValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function lessonWithQuestions(
  id: string,
  questions: LessonQuestion[],
  questionAlternates?: Lesson["questionAlternates"],
  glossary: Lesson["glossary"] = [],
): Lesson {
  return { ...lesson, id, schemaVersion: questionAlternates ? 3 : 2, questions, questionAlternates, glossary };
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("fullscreen lesson player", () => {
  it("keeps the mastered position on an incorrect retry and shows red feedback", async () => {
    await renderPlayer();
    expect(document.querySelector("#background")?.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".lesson-fullscreen-progress strong")?.textContent).toBe("1/2");

    await selectAnswer("b");
    await act(async () => button("Check answer").click());
    expect(document.querySelector(".lesson-feedback-tray.is-incorrect")).not.toBeNull();
    expect(document.querySelector(".lesson-coach-chat textarea")?.hasAttribute("disabled")).toBe(true);

    await act(async () => button("Continue").click());
    expect(document.querySelector(".lesson-fullscreen-progress strong")?.textContent).toBe("1/2");
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("second answer");
  });

  it("flushes pending progress before calling the explicit exit callback", async () => {
    const order: string[] = [];
    const onProgressBatch = vi.fn(async () => { order.push("progress"); });
    const onExit = vi.fn(() => { order.push("exit"); });
    await renderPlayer({ onProgressBatch, onExit });

    await selectAnswer("a");
    await act(async () => button("Check answer").click());
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
    await act(async () => button("Continue").click());
    expect(document.querySelector(".lesson-fullscreen-progress strong")?.textContent).toBe("2/2");

    await act(async () => button("Exit lesson").click());
    expect(onProgressBatch).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["progress", "exit"]);
  });

  it("sends coaching only after an explicit message and keeps history in the active session", async () => {
    const onAskCoach = vi.fn(async () => "A is correct because it matches the answer key.");
    await renderPlayer({ coachingAvailable: true, onAskCoach });
    await selectAnswer("a");
    await act(async () => button("Check answer").click());
    expect(onAskCoach).not.toHaveBeenCalled();

    const textarea = document.querySelector<HTMLTextAreaElement>(".lesson-coach-chat textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Why is A correct?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send coaching message").click());

    expect(onAskCoach).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q1" }),
      expect.objectContaining({ status: "correct" }),
      "Why is A correct?",
      [],
    );
    expect(document.querySelector(".lesson-coach-messages")?.textContent).toContain("Why is A correct?");
    expect(document.querySelector(".lesson-coach-messages")?.textContent).toContain("matches the answer key");
  });

  it("moves a skipped slot without progress and activates its prepared format on skip four", async () => {
    const primary = { ...lesson.questions[0], id: "skip-primary", prompt: "Original question" } as LessonQuestion;
    const alternate = { ...lesson.questions[1], id: "skip-alternate", prompt: "Replacement question" } as LessonQuestion;
    const onProgressBatch = vi.fn();
    await renderPlayer({
      lesson: lessonWithQuestions("skip-test", [primary], [{ questionId: primary.id, question: alternate }]),
      onProgressBatch,
    });

    for (let count = 1; count <= 3; count += 1) {
      await act(async () => button("Skip").click());
      expect(document.querySelector("#lesson-player-title")?.textContent).toContain("Original question");
    }
    await act(async () => button("Skip").click());

    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("Replacement question");
    expect(document.querySelector(".lesson-fullscreen-progress strong")?.textContent).toBe("1/1");
    expect(document.querySelector(".lesson-player-notice")?.textContent).toContain("Skipped 4 times");
    expect(onProgressBatch).not.toHaveBeenCalled();
  });

  it("persists a listening cooldown and automatically uses a non-listening alternate after reload", async () => {
    const primary: LessonQuestion = {
      id: "listen-primary",
      type: "dictation",
      prompt: "Listen and type",
      explanation: "Transcript match.",
      evaluationMode: "local",
      transcript: "Good morning",
      acceptedAnswers: ["Good morning"],
    };
    const alternate = { ...lesson.questions[0], id: "listen-alternate", prompt: "Read instead" } as LessonQuestion;
    const listeningLesson = lessonWithQuestions("listening-test", [primary], [{ questionId: primary.id, question: alternate }]);
    await renderPlayer({ lesson: listeningLesson });

    await act(async () => button("Can't listen now").click());
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("Read instead");
    expect(Array.from(document.querySelectorAll("button")).some((candidate) => candidate.textContent?.includes("Can't listen now"))).toBe(false);
    const stored = JSON.parse(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY) ?? "{}") as { listeningDisabledUntil?: number };
    expect(stored.listeningDisabledUntil).toBeGreaterThan(Date.now());

    await act(async () => root?.unmount());
    root = null;
    await renderPlayer({ lesson: listeningLesson });
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("Read instead");
  });

  it("persists learning-aid overrides and resets them with pronunciation defaults", async () => {
    await renderPlayer();
    await act(async () => button("Lesson settings").click());
    const labels = Array.from(document.querySelectorAll<HTMLLabelElement>(".lesson-settings-toggle"));
    const readQuestion = labels.find((label) => label.textContent?.includes("Read question"))!.querySelector<HTMLInputElement>("input")!;
    const pronunciation = labels.find((label) => label.textContent?.includes("Show pronunciation"))!.querySelector<HTMLInputElement>("input")!;

    await act(async () => readQuestion.click());
    await act(async () => pronunciation.click());
    await act(async () => button("Native reading").click());
    let stored = JSON.parse(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored).toMatchObject({ readQuestion: true, showPronunciation: false, pronunciationMode: "native" });

    await act(async () => button("Reset to lesson defaults").click());
    expect(readQuestion.checked).toBe(false);
    expect(pronunciation.checked).toBe(true);
    expect(button("Romanized").getAttribute("aria-pressed")).toBe("true");
    stored = JSON.parse(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY) ?? "{}") as Record<string, unknown>;
    expect(stored).not.toHaveProperty("readQuestion");
    expect(stored).toMatchObject({ showPronunciation: true, pronunciationMode: "romanized" });
  });

  it("renders ruby pronunciation and a safe multi-meaning glossary tooltip", async () => {
    const question = {
      ...lesson.questions[0],
      id: "glossary-question",
      prompt: "Choose \u6c34",
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: true },
    } as LessonQuestion;
    await renderPlayer({
      lesson: lessonWithQuestions("glossary-test", [question], undefined, [{
        term: "\u6c34",
        meaning: "water",
        otherMeanings: ["a liquid element in compounds"],
        pronunciation: { native: "\u307f\u305a", romanized: "mizu" },
        example: "\u6c34\u3092\u98f2\u307f\u307e\u3059\u3002",
      }]),
    });

    expect(document.querySelector("ruby rt")?.textContent).toBe("mizu");
    const term = document.querySelector<HTMLElement>(".glossary-term")!;
    await act(async () => term.click());
    expect(document.querySelector(".glossary-tooltip")?.textContent).toContain("a liquid element in compounds");
    expect(document.querySelector(".glossary-tooltip")?.textContent).toContain("mizu");

    await act(async () => button("Lesson settings").click());
    await act(async () => button("Native reading").click());
    expect(document.querySelector("ruby rt")?.textContent).toBe("\u307f\u305a");
  });

  it("keeps a free-writing draft while adding, removing, and reordering word-bank chips", async () => {
    const writing: LessonQuestion = {
      id: "writing",
      type: "freeWriting",
      prompt: "Write a routine",
      explanation: "Use a clear sequence.",
      evaluationMode: "ai",
      minWords: 2,
      maxWords: 30,
      rubric: ["Clarity"],
      supportBank: [
        { id: "usually", label: "usually" }, { id: "then", label: "then" },
        { id: "wake", label: "wake up" }, { id: "eat", label: "eat" },
        { id: "walk", label: "walk" }, { id: "work", label: "work" },
        { id: "home", label: "home" }, { id: "finally", label: "finally" },
      ],
      supportBankSeparator: "space",
    };
    await renderPlayer({ lesson: lessonWithQuestions("writing-test", [writing]) });
    await setTextValue(document.querySelector<HTMLTextAreaElement>(".free-writing-response textarea")!, "I");
    await act(async () => button("Use word bank").click());
    await act(async () => button("usually").click());
    await act(async () => button("then").click());
    await act(async () => button("Move then up").click());
    await act(async () => button("Remove usually").click());
    await act(async () => button("Use keyboard").click());

    expect(document.querySelector<HTMLTextAreaElement>(".free-writing-response textarea")?.value).toBe("I then");
  });
});
