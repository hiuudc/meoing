// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonPlayer } from "./LessonPlayer";
import { LESSON_PLAYER_PREFERENCE_KEY } from "./playerPreferences";
import { SPEECH_PREFERENCE_KEY } from "./speech";
import type { AttemptRecord, CharacterTracingQuestion, Lesson, LessonQuestion, PlayableLesson } from "./types";

const tracingMocks = vi.hoisted(() => {
  const writer = {
    cancelQuiz: vi.fn(),
    hideCharacter: vi.fn(),
    quiz: vi.fn(),
  };
  const animationWriter = {
    animateStroke: vi.fn(),
    hideCharacter: vi.fn(),
    updateColor: vi.fn(),
  };
  return {
    animationWriter,
    create: vi.fn((target: HTMLElement) => (
      target.classList.contains("hanzi-writer-animation-target") ? animationWriter : writer
    )),
    loadStrokeCharacterData: vi.fn(),
    writer,
  };
});

vi.mock("hanzi-writer", () => ({
  default: { create: tracingMocks.create },
}));

vi.mock("./strokeData", () => ({
  loadStrokeCharacterData: tracingMocks.loadStrokeCharacterData,
}));

const emptyTracking = {
  encountered: { words: [], phrases: [], sentences: [] },
  assessed: { words: [], phrases: [], sentences: [] },
};

const lesson: Lesson = {
  schemaVersion: 8,
  id: "player-test",
  unitId: "unit-test",
  title: "Player test",
  summary: "A compact player interaction fixture.",
  targetLanguage: "English",
  sourceLanguage: "Vietnamese",
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
      tracking: emptyTracking,
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
      tracking: emptyTracking,
      options: [{ id: "c", label: "C" }, { id: "d", label: "D" }],
      correctOptionId: "c",
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: false },
    },
  ],
  questionAlternates: [],
  createdAt: "2026-07-20T00:00:00.000Z",
};

let root: Root | null = null;
let speechVoices: SpeechSynthesisVoice[] = [];
let spokenUtterances: TestSpeechUtterance[] = [];

class TestSpeechUtterance {
  lang = "";
  pitch = 1;
  rate = 1;
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  volume = 1;

  constructor(text: string) {
    this.text = text;
  }
}

function speechVoice(name: string, lang: string, voiceURI: string, isDefault = false): SpeechSynthesisVoice {
  return { default: isDefault, lang, localService: true, name, voiceURI };
}

function memoryLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

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
  return {
    ...lesson,
    id,
    schemaVersion: 8,
    questions: questions.map((question) => ({
      ...question,
      tracking: question.tracking ?? emptyTracking,
    })),
    questionAlternates: (questionAlternates ?? []).map((alternate) => ({
      ...alternate,
      question: {
        ...alternate.question,
        tracking: alternate.question.tracking ?? emptyTracking,
      },
    })),
    glossary,
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryLocalStorage(),
  });
  window.localStorage.clear();
  speechVoices = [];
  spokenUtterances = [];
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: TestSpeechUtterance,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: TestSpeechUtterance) => spokenUtterances.push(utterance)),
      getVoices: () => speechVoices,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  tracingMocks.create.mockClear();
  tracingMocks.writer.cancelQuiz.mockClear();
  tracingMocks.writer.hideCharacter.mockReset().mockResolvedValue(undefined);
  tracingMocks.writer.quiz.mockReset().mockResolvedValue(undefined);
  tracingMocks.animationWriter.animateStroke.mockReset().mockResolvedValue({ canceled: false });
  tracingMocks.animationWriter.hideCharacter.mockReset().mockResolvedValue(undefined);
  tracingMocks.animationWriter.updateColor.mockReset().mockResolvedValue(undefined);
  tracingMocks.loadStrokeCharacterData.mockReset().mockResolvedValue({
    logicalData: {
      strokes: ["M 0 0 L 100 100"],
      medians: [[[0, 0], [100, 100]]],
    },
    animationData: {
      strokes: ["M 0 0 L 100 100"],
      medians: [[[0, 0], [100, 100]]],
    },
    animationGroups: [[0]],
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("fullscreen lesson player", () => {
  it("wraps backward focus from the initially focused dialog", async () => {
    await renderPlayer();
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    const dialog = document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const lastFocusable = focusable[focusable.length - 1];
    dialog.focus();

    const keyEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
      shiftKey: true,
    });
    await act(async () => {
      dialog.dispatchEvent(keyEvent);
    });

    expect(keyEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(lastFocusable);
  });

  it("makes the lesson inert and suspends its shortcuts while an overlaid modal is active", async () => {
    const onExit = vi.fn();
    await renderPlayer({ interactionSuspended: true, onExit });
    const dialog = document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!;

    expect(dialog.inert).toBe(true);
    expect(dialog.getAttribute("aria-hidden")).toBe("true");

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "1",
    })));
    expect(document.querySelector<HTMLInputElement>('input[value="a"]')?.checked).toBe(false);

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    })));
    expect(onExit).not.toHaveBeenCalled();
  });

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

  it("uses Enter to check and continue while ignoring composition and open settings", async () => {
    await renderPlayer();
    await selectAnswer("a");
    const dialog = document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!;

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      isComposing: true,
      key: "Enter",
    })));
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();

    await act(async () => button("Lesson settings").click());
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })));
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();
    await act(async () => button("Close lesson settings").click());

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })));
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })));
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("second answer");
  });

  it("focuses Continue after an auto-graded matching question and advances with Enter", async () => {
    const matching: LessonQuestion = {
      id: "auto-matching",
      type: "matching",
      prompt: "Match the pair",
      explanation: "The pair matches.",
      evaluationMode: "local",
      pairs: [{ leftId: "water", left: "water", rightId: "mizu", right: "mizu" }],
    };
    await renderPlayer({
      lesson: lessonWithQuestions("auto-matching-test", [matching, lesson.questions[1]]),
    });

    await act(async () => button("water").click());
    await act(async () => {
      button("mizu").click();
      await Promise.resolve();
    });
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(2);
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 360));
    });

    const continueButton = button("Continue");
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
    expect(document.activeElement).toBe(continueButton);
    expect(Array.from(document.querySelectorAll("button")).some((candidate) => candidate.textContent?.includes("Check answer"))).toBe(false);

    await act(async () => document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    ));
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("second answer");
  });

  it("keeps number shortcuts active after a matching pair is locked", async () => {
    const matching: LessonQuestion = {
      id: "number-matching-player",
      type: "matching",
      prompt: "Match both pairs",
      explanation: "Both pairs match.",
      evaluationMode: "local",
      pairs: [
        { leftId: "water", left: "water", rightId: "mizu", right: "mizu" },
        { leftId: "tea", left: "tea", rightId: "ocha", right: "ocha" },
      ],
    };
    await renderPlayer({
      lesson: lessonWithQuestions("number-matching-player-test", [matching]),
    });
    const stage = document.querySelector<HTMLElement>("[data-question-focus-root]")!;

    async function pressMatchingItem(text: string) {
      const control = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-lesson-hotkey-index]"))
        .find((candidate) => candidate.textContent?.includes(text) && !candidate.disabled);
      if (!control?.dataset.lessonHotkeyIndex) throw new Error(`Matching item not found: ${text}`);
      const digit = control.dataset.lessonHotkeyIndex;
      await act(async () => {
        stage.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: `Digit${digit}`,
          key: digit,
        }));
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
    }

    await pressMatchingItem("water");
    await pressMatchingItem("mizu");
    expect(document.querySelectorAll(".pair-grid-row > button.is-locked")).toHaveLength(2);
    expect(document.activeElement).toBe(stage);

    await pressMatchingItem("tea");
    await pressMatchingItem("ocha");
    expect(document.querySelectorAll(".pair-grid-row > button.is-locked")).toHaveLength(4);
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(4);
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 360));
    });
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
  });

  it("uses global number badges for Categorize and reuses categories", async () => {
    const categorize: LessonQuestion = {
      id: "number-categorize-player",
      type: "categorize",
      prompt: "Categorize the words",
      explanation: "Each word belongs to its category.",
      evaluationMode: "local",
      categories: [
        { id: "drink", label: "Drink" },
        { id: "person", label: "Person" },
      ],
      items: [
        { id: "water", label: "water", categoryId: "drink" },
        { id: "student", label: "student", categoryId: "person" },
      ],
    };
    await renderPlayer({
      lesson: lessonWithQuestions("number-categorize-player-test", [categorize]),
    });
    const stage = document.querySelector<HTMLElement>("[data-question-focus-root]")!;

    async function pressNumber(digit: string, numpad = false) {
      await act(async () => {
        stage.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: numpad ? `Numpad${digit}` : `Digit${digit}`,
          key: digit,
        }));
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
    }

    await pressNumber("1");
    await pressNumber("3");
    expect(document.querySelectorAll(".categorize-items button.is-locked")).toHaveLength(1);
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(2);
    expect(document.activeElement).toBe(stage);
    expect(document.querySelector<HTMLButtonElement>('[data-lesson-hotkey-index="3"]')?.disabled).toBe(true);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 360));
    });
    expect(document.querySelector<HTMLButtonElement>('[data-lesson-hotkey-index="3"]')?.disabled).toBe(false);

    await pressNumber("2", true);
    await pressNumber("4", true);
    expect(document.querySelectorAll(".categorize-items button.is-locked")).toHaveLength(2);
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(2);
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 360));
    });
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
  });

  it("checks an answer textarea with Enter and preserves Shift+Enter for a newline", async () => {
    const writing: LessonQuestion = {
      id: "enter-writing",
      type: "freeWriting",
      prompt: "Write an answer",
      explanation: "Use a complete sentence.",
      evaluationMode: "ai",
      minWords: 1,
      maxWords: 20,
      rubric: ["Clarity"],
    };
    const onEvaluate = vi.fn(async () => ({
      status: "correct" as const,
      score: 1,
      correctParts: ["Complete sentence"],
      errors: [],
      correction: "A complete sentence.",
      explanation: "The response is clear.",
      nextHint: "",
    }));
    await renderPlayer({
      lesson: lessonWithQuestions("enter-writing-test", [writing]),
      onEvaluate,
    });
    const textarea = document.querySelector<HTMLTextAreaElement>(".free-writing-response textarea")!;
    await setTextValue(textarea, "A complete sentence.");

    const shiftEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    });
    await act(async () => textarea.dispatchEvent(shiftEnter));
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onEvaluate).not.toHaveBeenCalled();

    const enter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });
    await act(async () => {
      textarea.dispatchEvent(enter);
      await Promise.resolve();
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(onEvaluate).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
  });

  it("grades a Translation word bank locally but keeps keyboard input on ChatGPT evaluation", async () => {
    const translation: LessonQuestion = {
      id: "translation-input-mode",
      type: "translation",
      prompt: "Translate into English",
      sourceText: "Tôi uống nước.",
      targetLanguage: "English",
      referenceAnswer: "I drink water.",
      rubric: ["Meaning"],
      explanation: "The word order matches the model answer.",
      evaluationMode: "ai",
      answerBank: {
        tokens: [
          { id: "i", label: "I" },
          { id: "drink", label: "drink" },
          { id: "water", label: "water" },
          { id: "tea", label: "tea" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    };
    const onEvaluate = vi.fn(async () => ({
      status: "correct" as const,
      score: 1,
      correctParts: ["Meaning"],
      errors: [],
      correction: "I drink water.",
      explanation: "The translation is correct.",
      nextHint: "",
    }));

    await renderPlayer({
      lesson: lessonWithQuestions("translation-bank-local", [translation]),
      onEvaluate,
    });
    await act(async () => button("I").click());
    await act(async () => button("drink").click());
    await act(async () => button("water").click());
    await act(async () => button("Check answer").click());

    expect(onEvaluate).not.toHaveBeenCalled();
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();

    await act(async () => root?.unmount());
    root = null;
    await renderPlayer({
      lesson: lessonWithQuestions("translation-keyboard-ai", [translation]),
      onEvaluate,
    });
    await act(async () => button("Use keyboard").click());
    const textarea = document.querySelector<HTMLTextAreaElement>(".open-response textarea")!;
    await setTextValue(textarea, "I drink water.");
    await act(async () => button("Check answer").click());

    expect(onEvaluate).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
  });

  it("grades a Short Answer word bank locally without calling ChatGPT", async () => {
    const shortAnswer: LessonQuestion = {
      id: "short-answer-input-mode",
      type: "shortAnswer",
      prompt: "Explain the sentence",
      referenceAnswer: "Because it is polite.",
      requiredIdeas: ["polite"],
      rubric: ["Meaning"],
      explanation: "The selected words match the reference answer.",
      evaluationMode: "ai",
      answerBank: {
        tokens: [
          { id: "because", label: "Because" },
          { id: "it", label: "it" },
          { id: "is", label: "is" },
          { id: "polite", label: "polite" },
          { id: "casual", label: "casual" },
        ],
        separator: "space",
        defaultMode: "keyboard",
      },
    };
    const onEvaluate = vi.fn();
    await renderPlayer({
      lesson: lessonWithQuestions("short-answer-bank-local", [shortAnswer]),
      onEvaluate,
    });

    await act(async () => button("Use word bank").click());
    await act(async () => button("Because").click());
    await act(async () => button("it").click());
    await act(async () => button("is").click());
    await act(async () => button("polite").click());
    await act(async () => button("Check answer").click());

    expect(onEvaluate).not.toHaveBeenCalled();
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
  });

  it("checks a selected inline word-bank answer with Enter and advances only after feedback", async () => {
    const fillBlank: LessonQuestion = {
      id: "inline-enter",
      type: "fillBlank",
      prompt: "Complete the sentence",
      targetPrompt: "I drink {{blank:object}}.",
      explanation: "Water completes the sentence.",
      evaluationMode: "local",
      template: "I drink {{blank:object}}.",
      acceptedAnswers: ["water"],
      answerBank: {
        tokens: [{ id: "water", label: "water" }, { id: "tea", label: "tea" }],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await renderPlayer({
      lesson: lessonWithQuestions("inline-enter-test", [fillBlank, lesson.questions[1]]),
    });

    await act(async () => {
      button("water").click();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    const response = document.querySelector<HTMLElement>(".multi-cloze-response")!;
    expect(document.activeElement).toBe(response);
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("Complete the sentence");
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();

    await act(async () => response.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })));
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("Complete the sentence");

    const continueButton = button("Continue");
    await act(async () => continueButton.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })));
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("second answer");
  });

  it("uses number shortcuts outside the choice group without moving to the next question", async () => {
    await renderPlayer();
    const stage = document.querySelector<HTMLElement>(".lesson-question-stage")
      ?? document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!;
    stage.focus();

    await act(async () => stage.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Numpad1",
      key: "1",
    })));
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));

    expect(document.querySelector<HTMLInputElement>('input[value="a"]')?.checked).toBe(true);
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("first answer");
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();
    expect(document.activeElement).toBe(stage);
  });

  it("accepts a valid true-false shortcut immediately after an out-of-range digit", async () => {
    const trueFalse: LessonQuestion = {
      id: "true-false-invalid-digit-player",
      type: "trueFalse",
      prompt: "True or false",
      explanation: "True",
      evaluationMode: "local",
      statement: "The statement is true.",
      correct: true,
    };
    await renderPlayer({
      lesson: lessonWithQuestions("true-false-invalid-digit-player-test", [trueFalse]),
    });
    const dialog = document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!;

    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit3",
        key: "3",
      }));
      dialog.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Digit1",
        key: "1",
      }));
    });

    expect(document.querySelector<HTMLInputElement>('input[value="true"]')?.checked).toBe(true);
    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();
  });

  it("keeps Continue focused when Enter follows a number shortcut before its focus frame", async () => {
    await renderPlayer();
    const dialog = document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!;

    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit1",
      key: "1",
    })));
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
      await Promise.resolve();
    });
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));

    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
    expect(document.activeElement).toBe(button("Continue"));
  });

  it("toggles multiple-choice answers from repeated global digit shortcuts without leaving a focus border", async () => {
    const multipleChoice: LessonQuestion = {
      id: "global-multiple-choice",
      type: "multipleChoice",
      prompt: "Choose two answers.",
      explanation: "A and B are correct.",
      evaluationMode: "local",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
      correctOptionIds: ["a", "b"],
    };
    await renderPlayer({ lesson: lessonWithQuestions("global-multiple-choice-test", [multipleChoice]) });
    const dialog = document.querySelector<HTMLElement>(".lesson-fullscreen-dialog")!;
    const stage = document.querySelector<HTMLElement>("[data-question-focus-root]")!;
    const expectedSelections = [
      ["c"],
      ["a", "c"],
      ["a", "b", "c"],
      ["a", "b"],
      ["b"],
      [],
    ];

    for (const [index, digit] of ["3", "1", "2", "3", "1", "2"].entries()) {
      await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code: index % 2 ? `Numpad${digit}` : `Digit${digit}`,
          key: digit,
        }));
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      });
      const checked = Array.from(document.querySelectorAll<HTMLInputElement>(".choice-list input:checked"))
        .map((input) => input.value);
      expect(checked).toEqual(expectedSelections[index]);
      expect(document.activeElement).toBe(stage);
    }

    expect(document.querySelector(".lesson-feedback-tray")).toBeNull();
  });

  it("focuses the answer field at the end when switching from word bank to keyboard", async () => {
    const writing: LessonQuestion = {
      id: "focus-writing",
      type: "freeWriting",
      prompt: "Write an answer",
      explanation: "Use a complete sentence.",
      evaluationMode: "ai",
      minWords: 1,
      maxWords: 20,
      rubric: ["Clarity"],
      answerBank: {
        tokens: [{ id: "hello", label: "hello" }, { id: "world", label: "world" }],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await renderPlayer({ lesson: lessonWithQuestions("focus-writing-test", [writing]) });
    const toggle = button("Use keyboard");
    expect(toggle.querySelector("svg")).not.toBeNull();

    await act(async () => {
      toggle.click();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    const textarea = document.querySelector<HTMLTextAreaElement>(".free-writing-response textarea")!;
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(button("Use word bank").querySelector("svg")).not.toBeNull();
  });

  it("focuses the first empty keyboard blank when the next question opens", async () => {
    const fillBlank = (id: string, acceptedAnswer: string): LessonQuestion => ({
      id,
      type: "fillBlank",
      prompt: `Complete ${id}`,
      targetPrompt: `I drink {{blank:object}} in ${id}.`,
      explanation: "Complete the sentence.",
      evaluationMode: "local",
      template: `I drink {{blank:object}} in ${id}.`,
      acceptedAnswers: [acceptedAnswer],
      answerBank: {
        tokens: [{ id: acceptedAnswer, label: acceptedAnswer }],
        separator: "space",
        defaultMode: "keyboard",
      },
    });
    await renderPlayer({
      lesson: lessonWithQuestions("keyboard-question-focus", [
        fillBlank("question-one", "water"),
        fillBlank("question-two", "tea"),
      ]),
    });
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    const firstInput = document.querySelector<HTMLInputElement>("[data-question-answer-input]")!;
    expect(document.activeElement).toBe(firstInput);

    await setTextValue(firstInput, "water");
    await act(async () => firstInput.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })));
    await act(async () => button("Continue").click());
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));

    const secondInput = document.querySelector<HTMLInputElement>("[data-question-answer-input]")!;
    expect(secondInput).not.toBe(firstInput);
    expect(document.activeElement).toBe(secondInput);
    expect(secondInput.selectionStart).toBe(secondInput.value.length);
  });

  it("updates and resets the word-bank typeahead timeout without browser persistence", async () => {
    await renderPlayer();
    await act(async () => button("Lesson settings").click());
    const slider = document.querySelector<HTMLInputElement>("#lesson-typeahead-timeout")!;
    expect(slider.min).toBe("1");
    expect(slider.max).toBe("10");
    expect(slider.step).toBe("0.25");
    expect(slider.value).toBe("1.5");

    await setTextValue(slider, "2.75");
    expect(document.querySelector<HTMLOutputElement>(".lesson-typeahead-control output")?.textContent).toBe("2.75s");
    expect(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY)).toBeNull();

    await act(async () => button("Reset to lesson defaults").click());
    expect(slider.value).toBe("1.5");
    expect(document.querySelector<HTMLOutputElement>(".lesson-typeahead-control output")?.textContent).toBe("1.5s");
  });

  it("uses a modified Skip shortcut without writing browser storage", async () => {
    await renderPlayer();
    await act(async () => button("Lesson settings").click());
    const recorder = button("Alt+S");
    await act(async () => recorder.click());
    await act(async () => recorder.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "k",
      shiftKey: true,
    })));
    expect(document.querySelector(".lesson-shortcut-status")?.textContent).toContain("Shift+K");
    expect(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY)).toBeNull();

    await act(async () => button("Close lesson settings").click());
    const answer = document.querySelector<HTMLInputElement>('input[value="a"]')!;
    await act(async () => answer.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "K",
      shiftKey: true,
    })));
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("second answer");
  });

  it("flushes pending progress before calling the explicit exit callback", async () => {
    const order: string[] = [];
    const onProgressBatch = vi.fn(async (_attempts: AttemptRecord[]) => { order.push("progress"); });
    const onExit = vi.fn(() => { order.push("exit"); });
    await renderPlayer({ onProgressBatch, onExit });

    await selectAnswer("a");
    await act(async () => button("Check answer").click());
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
    await act(async () => button("Continue").click());
    expect(document.querySelector(".lesson-fullscreen-progress strong")?.textContent).toBe("2/2");

    await act(async () => button("Exit lesson").click());
    expect(onProgressBatch).toHaveBeenCalledTimes(1);
    expect(onProgressBatch.mock.calls[0][0][0]).toMatchObject({
      questionId: "q1",
      attemptNumber: 1,
      answer: "a",
      evaluationSource: "server_rule",
      outcome: "correct",
      transcript: null,
    });
    expect(onProgressBatch.mock.calls[0][0][0].attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["progress", "exit"]);
  });

  it("does not advance until an attempt is durable and retries the same attempt after storage failure", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const onProgressBatch = vi.fn()
      .mockImplementationOnce(() => firstSave)
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
      .mockResolvedValue(undefined);
    await renderPlayer({ onProgressBatch });

    await selectAnswer("a");
    await act(async () => button("Check answer").click());
    await act(async () => {
      button("Continue").click();
      await Promise.resolve();
    });

    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("first answer");
    expect(onProgressBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirstSave?.();
      await firstSave;
    });
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("second answer");

    await selectAnswer("c");
    await act(async () => button("Check answer").click());
    await act(async () => button("Continue").click());
    expect(document.querySelector(".inline-error")?.textContent).toContain("could not be saved");
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("second answer");
    const rejectedAttempt = onProgressBatch.mock.calls[1][0][0] as AttemptRecord;

    await act(async () => button("Continue").click());
    const retriedAttempt = onProgressBatch.mock.calls[2][0][0] as AttemptRecord;
    expect(retriedAttempt.attemptId).toBe(rejectedAttempt.attemptId);
    expect(onProgressBatch).toHaveBeenCalledTimes(3);
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
    const shiftEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    });
    await act(async () => textarea.dispatchEvent(shiftEnter));
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onAskCoach).not.toHaveBeenCalled();

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }));
      await Promise.resolve();
    });

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

  it("keeps a listening cooldown in the current lesson only", async () => {
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
    expect(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY)).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    await renderPlayer({ lesson: listeningLesson });
    expect(document.querySelector("#lesson-player-title")?.textContent).toContain("Listen and type");
    expect(Array.from(document.querySelectorAll("button")).some((candidate) => candidate.textContent?.includes("Can't listen now"))).toBe(true);
  });

  it("keeps learning-aid overrides in memory and resets them with pronunciation defaults", async () => {
    await renderPlayer();
    await act(async () => button("Lesson settings").click());
    const labels = Array.from(document.querySelectorAll<HTMLLabelElement>(".lesson-settings-toggle"));
    const readQuestion = labels.find((label) => label.textContent?.includes("Read question"))!.querySelector<HTMLInputElement>("input")!;
    const pronunciation = labels.find((label) => label.textContent?.includes("Show pronunciation"))!.querySelector<HTMLInputElement>("input")!;

    await act(async () => readQuestion.click());
    await act(async () => pronunciation.click());
    await act(async () => button("Native reading").click());
    expect(readQuestion.checked).toBe(true);
    expect(pronunciation.checked).toBe(false);
    expect(button("Native reading").getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY)).toBeNull();

    await act(async () => button("Reset to lesson defaults").click());
    expect(readQuestion.checked).toBe(false);
    expect(pronunciation.checked).toBe(true);
    expect(button("Romanized").getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY)).toBeNull();
  });

  it("previews pronunciation, filters target voices, and speaks only target-language text", async () => {
    speechVoices = [
      speechVoice("English", "en-US", "voice-en", true),
      speechVoice("Japanese One", "ja-JP", "voice-ja-1"),
      speechVoice("Japanese Two", "ja_JP", "voice-ja-2"),
    ];
    const question = {
      ...lesson.questions[0],
      id: "speech-question",
      prompt: "Choose \u6c34",
      options: [
        { id: "water", label: "\u6c34" },
        { id: "tea", label: "\u304a\u8336" },
      ],
      correctOptionId: "water",
      glossaryTargets: ["\u6c34", "\u304a\u8336"],
      presentation: { readQuestion: true, readAnswers: true, wordTooltips: true },
    } as LessonQuestion;
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("speech-test", [question], undefined, [
          {
            term: "\u6c34",
            meaning: "water",
            pronunciation: { native: "\u307f\u305a", romanized: "mizu" },
          },
          { term: "\u304a\u8336", meaning: "tea", pronunciation: { native: "\u304a\u3061\u3083", romanized: "ocha" } },
        ]),
        targetLanguage: "Japanese",
      },
    });

    await act(async () => button("Lesson settings").click());
    const pronunciationCards = Array.from(document.querySelectorAll<HTMLButtonElement>(".pronunciation-mode button"));
    expect(pronunciationCards[0].textContent).toContain("mizu");
    expect(pronunciationCards[0].textContent).toContain("\u6c34");
    expect(pronunciationCards[1].textContent).toContain("\u307f\u305a");

    const voiceSelect = document.querySelector<HTMLSelectElement>(".lesson-voice-field select")!;
    expect(Array.from(voiceSelect.options).map((option) => option.textContent)).toEqual([
      "Automatic Japanese voice",
      "Japanese One \u00b7 ja-JP",
      "Japanese Two \u00b7 ja_JP",
    ]);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(voiceSelect, "voice-ja-2");
      voiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector(".lesson-voice-status")?.textContent).toContain("Japanese Two");

    const speed = document.querySelector<HTMLInputElement>("#lesson-voice-speed")!;
    expect(speed.type).toBe("range");
    expect(speed.min).toBe("0.25");
    expect(speed.max).toBe("2");
    expect(speed.step).toBe("0.05");
    expect(Array.from(document.querySelectorAll<HTMLElement>(".lesson-speed-control .lesson-speed-ticks > span")).map((tick) => tick.style.left))
      .toEqual(["0%", "42.857%", "71.429%", "100%"]);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(speed, "1.5");
      speed.dispatchEvent(new Event("input", { bubbles: true }));
      speed.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector(".lesson-speed-control output")?.textContent).toBe("1.5x");

    expect(spokenUtterances[spokenUtterances.length - 1]).toMatchObject({
      text: "\u6c34",
      rate: 1,
      lang: "ja_JP",
      voice: expect.objectContaining({ voiceURI: "voice-ja-2" }),
    });
    expect(window.localStorage.getItem(SPEECH_PREFERENCE_KEY)).toBeNull();

    await act(async () => button("Close lesson settings").click());
    expect(document.querySelector(".lesson-question-speakers")).toBeNull();
    expect(document.querySelector('.lesson-target-text[lang="ja-JP"] ruby')?.childNodes[0]?.textContent).toBe("\u6c34");
    await selectAnswer("water");
    expect(spokenUtterances[spokenUtterances.length - 1]).toMatchObject({
      text: "\u6c34",
      rate: 1.5,
      voice: expect.objectContaining({ voiceURI: "voice-ja-2" }),
    });
  });

  it("renders source and target prompts separately and speaks only the target row on demand", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const question = {
      ...lesson.questions[0],
      id: "target-prompt-question",
      prompt: "Choose the natural model sentence.",
      targetPrompt: "\u6c34\u3092\u98f2\u307f\u307e\u3059\u3002",
      glossaryTargets: ["\u6c34", "\u98f2\u307f\u307e\u3059"],
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: false },
    } as LessonQuestion;
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("target-prompt-test", [question], undefined, [
          { term: "\u6c34", meaning: "water", pronunciation: { native: "\u307f\u305a", romanized: "mizu" } },
          { term: "\u98f2\u307f\u307e\u3059", meaning: "drink", pronunciation: { native: "\u306e\u307f\u307e\u3059", romanized: "nomimasu" } },
        ]),
        targetLanguage: "Japanese",
      },
    });
    expect(document.querySelector("#lesson-player-title")?.textContent).toBe("Choose the natural model sentence.");
    const targetRow = document.querySelector(".lesson-target-prompt-row")!;
    expect(targetRow.querySelectorAll("ruby")).toHaveLength(2);
    expect(Array.from(targetRow.querySelectorAll("ruby")).map((ruby) => ruby.childNodes[0]?.textContent))
      .toEqual(["\u6c34", "\u98f2\u307f\u307e\u3059"]);
    expect(spokenUtterances).toHaveLength(0);
    const cancelCount = vi.mocked(window.speechSynthesis.cancel).mock.calls.length;

    await act(async () => button("Play Japanese prompt").click());
    expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u6c34\u3092\u98f2\u307f\u307e\u3059\u3002"]);
    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(cancelCount + 1);
  });

  it("auto-reads each new target-language question and interrupts speech for the next selected answer", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const question = {
      ...lesson.questions[0],
      id: "auto-speech-question",
      prompt: "Chọn \u6c34",
      options: [
        { id: "water", label: "\u6c34" },
        { id: "tea", label: "\u304a\u8336" },
      ],
      correctOptionId: "water",
      glossaryTargets: ["\u6c34", "\u304a\u8336"],
      presentation: { readQuestion: true, readAnswers: true, wordTooltips: false },
    } as LessonQuestion;
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("auto-speech-test", [question]),
        targetLanguage: "Japanese",
        glossary: [
          { term: "\u6c34", meaning: "nước" },
          { term: "\u304a\u8336", meaning: "trà" },
        ],
      },
    });

    expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u6c34"]);
    await selectAnswer("water");
    await selectAnswer("tea");

    expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u6c34", "\u6c34", "\u304a\u8336"]);
    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(4);
  });

  it("does not auto-read Audio Matching but speaks a selected audio tile", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const question: LessonQuestion = {
      id: "audio-matching-no-autoplay",
      type: "audioMatching",
      prompt: "Match each sound to its meaning.",
      explanation: "Match both pairs.",
      evaluationMode: "local",
      pairs: [
        { audioId: "water-audio", audioText: "\u6c34", matchId: "water-meaning", label: "water" },
        { audioId: "tea-audio", audioText: "\u304a\u8336", matchId: "tea-meaning", label: "tea" },
      ],
      glossaryTargets: ["\u6c34", "\u304a\u8336"],
      presentation: { readQuestion: true, readAnswers: true, wordTooltips: false },
    };
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("audio-matching-no-autoplay-test", [question], undefined, [
          { term: "\u6c34", meaning: "water", pronunciation: { native: "\u307f\u305a", romanized: "mizu" } },
          { term: "\u304a\u8336", meaning: "tea", pronunciation: { native: "\u304a\u3061\u3083", romanized: "ocha" } },
        ]),
        targetLanguage: "Japanese",
      },
    });

    expect(spokenUtterances).toHaveLength(0);
    const cancelCount = vi.mocked(window.speechSynthesis.cancel).mock.calls.length;
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-lesson-hotkey-index="1"]')!.click();
    });

    expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u6c34"]);
    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(cancelCount + 1);
  });

  it("renders glossary pronunciation in an incorrect answer correction", async () => {
    const question: LessonQuestion = {
      id: "correction-pronunciation",
      type: "errorCorrection",
      prompt: "Correct the sentence.",
      incorrectText: "\u79c1\u306f\u304a\u8336\u3092\u98f2\u307f\u307e\u3059\u3002",
      acceptedAnswers: ["\u79c1\u306f\u6c34\u3092\u98f2\u307f\u307e\u3059\u3002"],
      explanation: "Use the requested object.",
      evaluationMode: "local",
      glossaryTargets: [
        "\u79c1", "\u306f", "\u304a\u8336", "\u6c34", "\u3092", "\u98f2\u307f\u307e\u3059",
      ],
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: true },
    };
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("correction-pronunciation-test", [question], undefined, [
          { term: "\u79c1", meaning: "I", pronunciation: { native: "\u308f\u305f\u3057", romanized: "watashi" } },
          { term: "\u306f", meaning: "topic marker", pronunciation: { native: "\u306f", romanized: "wa" } },
          { term: "\u304a\u8336", meaning: "tea", pronunciation: { native: "\u304a\u3061\u3083", romanized: "ocha" } },
          { term: "\u6c34", meaning: "water", pronunciation: { native: "\u307f\u305a", romanized: "mizu" } },
          { term: "\u3092", meaning: "object marker", pronunciation: { native: "\u3092", romanized: "o" } },
          { term: "\u98f2\u307f\u307e\u3059", meaning: "drink", pronunciation: { native: "\u306e\u307f\u307e\u3059", romanized: "nomimasu" } },
        ]),
        targetLanguage: "Japanese",
      },
    });
    const input = document.querySelector<HTMLInputElement>('input[data-question-answer-input]')!;
    await setTextValue(input, "\u79c1\u306f\u304a\u8336\u3092\u98f2\u307f\u307e\u3059\u3002");
    await act(async () => button("Check answer").click());

    const correction = Array.from(document.querySelectorAll<HTMLParagraphElement>(".lesson-feedback-copy p"))
      .find((paragraph) => paragraph.textContent?.includes("Correction:"));
    expect(correction).toBeDefined();
    expect(Array.from(correction!.querySelectorAll("rt")).map((reading) => reading.textContent))
      .toEqual(["watashi", "wa", "mizu", "o", "nomimasu"]);
  });

  it("hides readings but speaks every activated glyph in Letters practice", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const question = {
      ...lesson.questions[0],
      id: "letters-choice-speech",
      prompt: "Select the matching character.",
      targetPrompt: "\u3043",
      options: [
        { id: "small-i", label: "\u3043" },
        { id: "vu", label: "\u3094" },
      ],
      correctOptionId: "small-i",
      glossaryTargets: ["\u3043", "\u3094"],
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: false },
    } as LessonQuestion;
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("letters-choice-speech-test", [question], undefined, [
          { term: "\u3043", meaning: "small i", pronunciation: { romanized: "i" } },
          { term: "\u3094", meaning: "vu", pronunciation: { romanized: "vu" } },
        ]),
        targetLanguage: "Japanese",
      },
      variant: "lettersPractice",
    });

    expect(document.querySelector("ruby")).toBeNull();
    expect(document.querySelector(".lesson-target-prompt-row button")).toBeNull();
    const distractor = document.querySelector<HTMLInputElement>('input[value="vu"]')!;
    const target = document.querySelector<HTMLInputElement>('input[value="small-i"]')!;
    await act(async () => distractor.click());
    await act(async () => target.click());
    await act(async () => target.click());

    expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u30f4", "\u3043", "\u3043"]);
    await act(async () => button("Check answer").click());
    expect(document.querySelector(".lesson-feedback-tray.is-correct")).not.toBeNull();
    expect(document.querySelector("ruby")).toBeNull();
  });

  it("auto-reads each trace presentation and exposes Letter settings in the left header actions", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const tracingQuestion: CharacterTracingQuestion = {
      id: "trace-hiragana-a",
      type: "characterTracing",
      prompt: "Trace the character.",
      explanation: "Follow the stroke order.",
      evaluationMode: "local",
      character: "\u3042",
      reading: "a",
      requireStrokeOrder: true,
      presentation: { readQuestion: true, readAnswers: false, wordTooltips: false },
    };
    const tracingLesson: PlayableLesson = {
      ...lesson,
      id: "trace-player-test",
      targetLanguage: "Japanese",
      questions: [tracingQuestion],
      questionAlternates: [],
    };
    const onOpenSettings = vi.fn();

    await renderPlayer({
      lesson: tracingLesson,
      variant: "lettersPractice",
      tracingOptions: {
        requireStrokeOrder: true,
        strokeTolerance: 1,
        showStrokeGuide: true,
        onOpenSettings,
      },
    });
    await vi.waitFor(() => expect(tracingMocks.writer.quiz).toHaveBeenCalled());
    await vi.waitFor(() => expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u3042"]));
    expect(document.querySelector(".character-tracing-glyph span")?.textContent).toBe("a");

    const settings = button("Open Letter settings");
    expect(settings.closest(".lesson-header-left-actions")).not.toBeNull();
    await act(async () => settings.click());
    expect(onOpenSettings).toHaveBeenCalledWith(settings);

    await act(async () => button("Skip").click());
    await vi.waitFor(() => expect(spokenUtterances.map((utterance) => utterance.text))
      .toEqual(["\u3042", "\u3042"]));
  });

  it("keeps Unicode-only tracing silent and omits its pronunciation control", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const tracingQuestion: CharacterTracingQuestion = {
      id: "trace-kanji-unicode",
      type: "characterTracing",
      prompt: "Trace the character.",
      explanation: "Follow the stroke order.",
      evaluationMode: "local",
      character: "\u6c34",
      reading: "U+6C34",
      requireStrokeOrder: true,
      presentation: { readQuestion: true, readAnswers: false, wordTooltips: false },
    };

    await renderPlayer({
      lesson: {
        ...lesson,
        id: "trace-unicode-test",
        targetLanguage: "Japanese",
        questions: [tracingQuestion],
        questionAlternates: [],
      },
      variant: "lettersPractice",
      tracingOptions: {
        requireStrokeOrder: true,
        strokeTolerance: 1,
        showStrokeGuide: true,
      },
    });

    await vi.waitFor(() => expect(tracingMocks.writer.quiz).toHaveBeenCalled());
    expect(spokenUtterances).toHaveLength(0);
    expect(document.querySelector(".character-tracing-glyph span")?.textContent).toBe("U+6C34");
    expect(document.querySelector('[aria-label="Play \u6c34 pronunciation"]')).toBeNull();
  });

  it("reads the current target text once when Read question is enabled mid-question", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const question = {
      ...lesson.questions[0],
      id: "toggle-speech-question",
      prompt: "Chọn \u6c34",
      glossaryTargets: ["\u6c34"],
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: false },
    } as LessonQuestion;
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("toggle-speech-test", [question]),
        targetLanguage: "Japanese",
        glossary: [{ term: "\u6c34", meaning: "nước" }],
      },
    });
    expect(spokenUtterances).toHaveLength(0);

    await act(async () => button("Lesson settings").click());
    const readQuestion = Array.from(document.querySelectorAll<HTMLLabelElement>(".lesson-settings-toggle"))
      .find((label) => label.textContent?.includes("Read question"))
      ?.querySelector<HTMLInputElement>("input");
    if (!readQuestion) throw new Error("Read question setting not found.");
    await act(async () => readQuestion.click());
    expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u6c34"]);

    await act(async () => button("Romanized").click());
    expect(spokenUtterances).toHaveLength(1);
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

  it("speaks the exact target term on tooltip hover independently of read settings", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const question = {
      ...lesson.questions[0],
      id: "tooltip-speech-question",
      prompt: "Choose \u6c34",
      glossaryTargets: ["\u6c34"],
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: true },
    } as LessonQuestion;
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("tooltip-speech-test", [question], undefined, [{
          term: "\u6c34",
          meaning: "water",
          pronunciation: { native: "\u307f\u305a", romanized: "mizu" },
        }]),
        targetLanguage: "Japanese",
      },
    });
    const cancelCount = vi.mocked(window.speechSynthesis.cancel).mock.calls.length;
    const term = document.querySelector<HTMLElement>(".lesson-target-prompt-row .glossary-term")!;

    await act(async () => term.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));

    expect(spokenUtterances).toHaveLength(1);
    expect(spokenUtterances[0]).toMatchObject({ text: "\u6c34", lang: "ja-JP" });
    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(cancelCount + 1);
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
    await renderPlayer({ lesson: lessonWithQuestions("writing-test", [writing, { ...writing, id: "writing-two" }]) });
    await setTextValue(document.querySelector<HTMLTextAreaElement>(".free-writing-response textarea")!, "I");
    await act(async () => button("Use word bank").click());
    const composer = document.querySelector<HTMLElement>(".answer-composer")!;
    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true })));
    expect(document.querySelectorAll(".is-typeahead-match").length).toBeGreaterThanOrEqual(2);
    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".lesson-fullscreen-dialog")).not.toBeNull();
    expect(document.querySelector(".is-typeahead-match")).toBeNull();
    await act(async () => button("usually").click());
    await act(async () => button("then").click());
    const thenChip = document.querySelector<HTMLButtonElement>('[data-answer-token-id="then"]')!;
    await act(async () => thenChip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-answer-token-id="usually"]')!.click());
    await act(async () => button("Use keyboard").click());

    expect(document.querySelector<HTMLTextAreaElement>(".free-writing-response textarea")?.value).toBe("I");
    await act(async () => button("Use word bank").click());
    await act(async () => button("Skip").click());
    expect(button("Use keyboard")).not.toBeNull();

    await act(async () => root?.unmount());
    root = null;
    await renderPlayer({ lesson: lessonWithQuestions("writing-test-fresh", [writing]) });
    expect(button("Use word bank")).not.toBeNull();
  });
});
