// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonPlayer } from "./LessonPlayer";
import { LESSON_PLAYER_PREFERENCE_KEY } from "./playerPreferences";
import { SPEECH_PREFERENCE_KEY } from "./speech";
import type { CharacterTracingQuestion, Lesson, LessonQuestion, PlayableLesson } from "./types";

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

const lesson: Lesson = {
  schemaVersion: 7,
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
  return { ...lesson, id, schemaVersion: 7, questions, questionAlternates: questionAlternates ?? [], glossary };
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

  it("persists and resets the word-bank typeahead timeout from Lesson settings", async () => {
    await renderPlayer();
    await act(async () => button("Lesson settings").click());
    const slider = document.querySelector<HTMLInputElement>("#lesson-typeahead-timeout")!;
    expect(slider.min).toBe("1");
    expect(slider.max).toBe("10");
    expect(slider.step).toBe("0.25");
    expect(slider.value).toBe("1.5");

    await setTextValue(slider, "2.75");
    expect(document.querySelector<HTMLOutputElement>(".lesson-typeahead-control output")?.textContent).toBe("2.75s");
    expect(JSON.parse(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY) ?? "{}").typeaheadTimeoutMs)
      .toBe(2_750);

    await act(async () => button("Reset to lesson defaults").click());
    expect(slider.value).toBe("1.5");
    expect(JSON.parse(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY) ?? "{}").typeaheadTimeoutMs)
      .toBe(1_500);
  });

  it("records and persists a modified Skip shortcut that works from an answer field", async () => {
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
    expect(JSON.parse(window.localStorage.getItem(LESSON_PLAYER_PREFERENCE_KEY) ?? "{}").skipShortcut)
      .toEqual({ key: "k", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true });

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
    expect(JSON.parse(window.localStorage.getItem(SPEECH_PREFERENCE_KEY) ?? "{}")).toMatchObject({
      voiceURI: "voice-ja-2",
      rate: 1.5,
    });

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

  it("hides readings but speaks every activated glyph in Letters practice", async () => {
    speechVoices = [speechVoice("Japanese", "ja-JP", "voice-ja", true)];
    const question = {
      ...lesson.questions[0],
      id: "letters-choice-speech",
      prompt: "Select the matching character.",
      targetPrompt: "\u3043",
      options: [
        { id: "small-i", label: "\u3043" },
        { id: "u", label: "\u3046" },
      ],
      correctOptionId: "small-i",
      glossaryTargets: ["\u3043", "\u3046"],
      presentation: { readQuestion: false, readAnswers: false, wordTooltips: false },
    } as LessonQuestion;
    await renderPlayer({
      lesson: {
        ...lessonWithQuestions("letters-choice-speech-test", [question], undefined, [
          { term: "\u3043", meaning: "small i", pronunciation: { romanized: "i" } },
          { term: "\u3046", meaning: "u", pronunciation: { romanized: "u" } },
        ]),
        targetLanguage: "Japanese",
      },
      variant: "lettersPractice",
    });

    expect(document.querySelector("ruby")).toBeNull();
    const distractor = document.querySelector<HTMLInputElement>('input[value="u"]')!;
    const target = document.querySelector<HTMLInputElement>('input[value="small-i"]')!;
    await act(async () => distractor.click());
    await act(async () => target.click());
    await act(async () => target.click());

    expect(spokenUtterances.map((utterance) => utterance.text)).toEqual(["\u3046", "\u3043", "\u3043"]);
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
