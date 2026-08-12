// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlossaryText } from "./GlossaryText";
import {
  AudioWaveform,
  QuestionRenderer,
  verticalInsertionIndex,
  type AnswerInputMode,
} from "./QuestionRenderer";
import type { LessonQuestion, QuestionAnswer } from "./types";

let root: Root | null = null;

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim().includes(label));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function Harness({
  question,
  evaluated = false,
  inputMode,
  typeaheadResetMs,
  onAnswerActivate,
  onComplete,
}: {
  question: LessonQuestion;
  evaluated?: boolean;
  inputMode?: AnswerInputMode;
  typeaheadResetMs?: number;
  onAnswerActivate?: (text: string) => void;
  onComplete?: (answer: QuestionAnswer) => void;
}) {
  const [answer, setAnswer] = useState<QuestionAnswer>("");
  return createElement(
    "div",
    null,
    createElement(QuestionRenderer, {
      question,
      answer,
      language: "English",
      evaluated,
      answerInputMode: inputMode,
      typeaheadResetMs,
      onChange: setAnswer,
      onAnswerActivate,
      onComplete,
      renderText: (text, interactive) => createElement("span", { "data-answer-interactive": String(Boolean(interactive)) }, text),
    }),
    createElement("output", { id: "answer-value" }, JSON.stringify(answer)),
  );
}

async function render(node: ReactNode) {
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => root!.render(node));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("QuestionRenderer interactions", () => {
  it("locks correct matching pairs and clears a wrong pair without creating an answer", async () => {
    vi.useFakeTimers();
    const question: LessonQuestion = {
      id: "matching",
      type: "matching",
      prompt: "Match",
      explanation: "Pairs",
      evaluationMode: "local",
      pairs: [
        { leftId: "water", left: "water", rightId: "nuoc", right: "nước" },
        { leftId: "tea", left: "tea", rightId: "tra", right: "trà" },
      ],
    };
    await render(createElement(Harness, { question }));

    await act(async () => button("water").click());
    await act(async () => button("trà").click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('""');
    expect(document.querySelectorAll(".is-wrong")).toHaveLength(2);

    await act(async () => vi.advanceTimersByTime(450));
    await act(async () => button("water").click());
    await act(async () => button("nước").click());
    expect(document.querySelector("#answer-value")?.textContent).toContain('"water":"nuoc"');
    expect(document.querySelectorAll(".pair-grid-row > button.is-locked")).toHaveLength(2);
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(2);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("Correct match");

    await act(async () => vi.advanceTimersByTime(349));
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(1));
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(0);
    expect(document.querySelectorAll(".pair-grid-row > button.is-locked")).toHaveLength(2);
  });

  it("selects matching badges from number and numpad keys and completes after the final pair", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const question: LessonQuestion = {
      id: "number-matching",
      type: "matching",
      prompt: "Match",
      explanation: "Pairs",
      evaluationMode: "local",
      pairs: [
        { leftId: "one", left: "one", rightId: "uno", right: "uno" },
        { leftId: "two", left: "two", rightId: "dos", right: "dos" },
      ],
    };
    await render(createElement(Harness, { question, onComplete }));
    const group = document.querySelector<HTMLElement>(".pair-matching")!;
    const rightBadge = (label: string) => Number(
      Array.from(group.querySelectorAll<HTMLButtonElement>("button"))
        .find((candidate) => candidate.textContent?.includes(label))
        ?.querySelector(".pair-index")?.textContent,
    );

    await act(async () => group.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, code: "Digit1", key: "1" }),
    ));
    await act(async () => {
      const badge = rightBadge("uno");
      group.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: `Numpad${badge}`,
        key: String(badge),
      }));
      await Promise.resolve();
    });
    expect(document.querySelectorAll(".pair-grid-row > button.is-locked")).toHaveLength(2);
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(350));
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(0);

    await act(async () => group.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, code: "Digit2", key: "2" }),
    ));
    await act(async () => {
      const badge = rightBadge("dos");
      group.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: `Numpad${badge}`,
        key: String(badge),
      }));
      await Promise.resolve();
    });
    expect(document.querySelectorAll(".pair-grid-row")).toHaveLength(2);
    expect(document.querySelectorAll(".pair-grid-row > button.is-locked")).toHaveLength(4);
    expect(document.querySelectorAll(".pair-grid-row > button.is-match-correct")).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(350));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ one: "uno", two: "dos" });
  });

  it("shows numeric badges and selects choice formats from number keys", async () => {
    const cases: Array<{ question: LessonQuestion; key: string; expected: string }> = [
      {
        question: {
          id: "single-numeric",
          type: "singleChoice",
          prompt: "Choose one",
          explanation: "One choice",
          evaluationMode: "local",
          options: [{ id: "one", label: "one" }, { id: "two", label: "two" }],
          correctOptionId: "two",
        },
        key: "2",
        expected: '"two"',
      },
      {
        question: {
          id: "multiple-numeric",
          type: "multipleChoice",
          prompt: "Choose several",
          explanation: "Several choices",
          evaluationMode: "local",
          options: [{ id: "one", label: "one" }, { id: "two", label: "two" }, { id: "three", label: "three" }],
          correctOptionIds: ["one", "three"],
        },
        key: "3",
        expected: '["three"]',
      },
      {
        question: {
          id: "true-false-numeric",
          type: "trueFalse",
          prompt: "True or false",
          explanation: "False",
          evaluationMode: "local",
          statement: "The statement is false.",
          correct: false,
        },
        key: "2",
        expected: "false",
      },
      {
        question: {
          id: "listen-select-numeric",
          type: "listenSelect",
          prompt: "Listen and choose",
          explanation: "Choose what you heard.",
          evaluationMode: "local",
          audioText: "\u3044",
          options: [{ id: "i", label: "\u3044" }, { id: "u", label: "\u3046" }],
          correctOptionId: "i",
        },
        key: "2",
        expected: '"u"',
      },
    ];

    await render(createElement(Harness, { key: cases[0].question.id, question: cases[0].question }));
    for (const [index, { question, key, expected }] of cases.entries()) {
      if (index > 0) {
        await act(async () => root!.render(createElement(Harness, { key: question.id, question })));
      }
      const choices = document.querySelector<HTMLFieldSetElement>(".choice-list")!;
      expect(choices.tabIndex).toBe(-1);
      expect(choices.classList.contains("is-numbered")).toBe(true);
      expect(Array.from(choices.querySelectorAll(".choice-index")).map((item) => item.textContent))
        .toEqual(Array.from({ length: choices.querySelectorAll("label").length }, (_, index) => String(index + 1)));
      await act(async () => choices.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: `Numpad${key}`,
        key,
      })));
      expect(document.querySelector("#answer-value")?.textContent).toBe(expected);
    }
  });

  it("discards an out-of-range digit immediately for short choice lists", async () => {
    const question: LessonQuestion = {
      id: "true-false-invalid-digit",
      type: "trueFalse",
      prompt: "True or false",
      explanation: "True",
      evaluationMode: "local",
      statement: "The statement is true.",
      correct: true,
    };
    await render(createElement(Harness, { question }));
    const choices = document.querySelector<HTMLFieldSetElement>(".choice-list")!;

    await act(async () => {
      choices.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Digit3",
        key: "3",
      }));
      choices.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Digit1",
        key: "1",
      }));
    });

    expect(document.querySelector("#answer-value")?.textContent).toBe("true");
  });

  it("speaks only when a single-choice option becomes selected", async () => {
    const onAnswerActivate = vi.fn();
    const question: LessonQuestion = {
      id: "single-choice-speech",
      type: "singleChoice",
      prompt: "Choose a drink",
      explanation: "Water is a drink.",
      evaluationMode: "local",
      options: [
        { id: "water", label: "water" },
        { id: "tea", label: "tea" },
      ],
      correctOptionId: "water",
    };
    await render(createElement(Harness, { question, onAnswerActivate }));

    const water = document.querySelector<HTMLInputElement>('input[value="water"]')!;
    await act(async () => water.click());
    expect(onAnswerActivate).toHaveBeenCalledTimes(1);
    expect(onAnswerActivate).toHaveBeenLastCalledWith("water");
    expect(document.querySelector("#answer-value")?.textContent).toBe('"water"');

    await act(async () => water.click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('"water"');
    expect(onAnswerActivate).toHaveBeenCalledTimes(1);

    const tea = document.querySelector<HTMLInputElement>('input[value="tea"]')!;
    await act(async () => tea.click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('"tea"');
    expect(onAnswerActivate).toHaveBeenCalledTimes(2);
    expect(onAnswerActivate).toHaveBeenLastCalledWith("tea");
  });

  it("does not speak when a multiple-choice option is deselected", async () => {
    const onAnswerActivate = vi.fn();
    const question: LessonQuestion = {
      id: "multiple-choice-speech",
      type: "multipleChoice",
      prompt: "Choose drinks",
      explanation: "Water and tea are drinks.",
      evaluationMode: "local",
      options: [
        { id: "water", label: "water" },
        { id: "tea", label: "tea" },
      ],
      correctOptionIds: ["water", "tea"],
    };
    await render(createElement(Harness, { question, onAnswerActivate }));

    const water = document.querySelector<HTMLInputElement>('input[value="water"]')!;
    await act(async () => water.click());
    expect(onAnswerActivate).toHaveBeenCalledTimes(1);
    expect(document.querySelector("#answer-value")?.textContent).toBe('["water"]');

    await act(async () => water.click());
    expect(document.querySelector("#answer-value")?.textContent).toBe("[]");
    expect(onAnswerActivate).toHaveBeenCalledTimes(1);
  });

  it("uses the same selection-only speech rule for number-key activation", async () => {
    const onAnswerActivate = vi.fn();
    const question: LessonQuestion = {
      id: "multiple-choice-number-speech",
      type: "multipleChoice",
      prompt: "Choose drinks",
      explanation: "Water and tea are drinks.",
      evaluationMode: "local",
      options: [
        { id: "water", label: "water" },
        { id: "tea", label: "tea" },
      ],
      correctOptionIds: ["water", "tea"],
    };
    await render(createElement(Harness, { question, onAnswerActivate }));
    const choices = document.querySelector<HTMLFieldSetElement>(".choice-list")!;

    async function pressNumber(digit: string) {
      await act(async () => choices.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: `Digit${digit}`,
        key: digit,
      })));
    }

    await pressNumber("1");
    await pressNumber("1");
    await pressNumber("2");

    expect(document.querySelector("#answer-value")?.textContent).toBe('["tea"]');
    expect(onAnswerActivate).toHaveBeenCalledTimes(2);
    expect(onAnswerActivate).toHaveBeenNthCalledWith(1, "water");
    expect(onAnswerActivate).toHaveBeenNthCalledWith(2, "tea");
  });

  it("keeps duplicate-label bank tokens distinct and supports keyboard reordering", async () => {
    const question: LessonQuestion = {
      id: "writing",
      type: "freeWriting",
      prompt: "Write",
      explanation: "Write",
      evaluationMode: "ai",
      minWords: 1,
      maxWords: 20,
      rubric: ["Clarity"],
      answerBank: {
        tokens: [
          { id: "same-one", label: "same" },
          { id: "same-two", label: "same" },
          { id: "end", label: "end" },
        ],
        separator: "space",
        defaultMode: "keyboard",
      },
    };
    await render(createElement(Harness, { question, inputMode: "bank" }));
    const bankButtons = document.querySelectorAll<HTMLButtonElement>(".token-bank button");
    await act(async () => bankButtons[0].click());
    await act(async () => bankButtons[1].click());
    expect(document.querySelectorAll("[data-answer-token-id]")).toHaveLength(2);
    expect(document.querySelector("#answer-value")?.textContent).toBe('"same same"');

    const second = document.querySelector<HTMLButtonElement>('[data-answer-token-id="same-two"]')!;
    await act(async () => second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })));
    expect(Array.from(document.querySelectorAll<HTMLElement>("[data-answer-token-id]")).map((element) => element.dataset.answerTokenId))
      .toEqual(["same-two", "same-one"]);

    await act(async () => button("end").click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('"same same end"');
    expect(document.querySelectorAll(".token-bank-placeholder")).toHaveLength(3);
  });

  it("filters bank tokens by prefix, auto-selects a unique match, and removes it silently", async () => {
    vi.useFakeTimers();
    const onAnswerActivate = vi.fn();
    const question: LessonQuestion = {
      id: "typeahead-writing",
      type: "freeWriting",
      prompt: "Write",
      explanation: "Write",
      evaluationMode: "ai",
      minWords: 1,
      maxWords: 20,
      rubric: ["Clarity"],
      answerBank: {
        tokens: [
          { id: "america", label: "America" },
          { id: "and", label: "and" },
          { id: "japan", label: "Japan" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await render(createElement(Harness, { question, inputMode: "bank", onAnswerActivate }));
    const composer = document.querySelector<HTMLElement>(".answer-composer")!;

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    expect(Array.from(document.querySelectorAll(".is-typeahead-match")).map((element) => element.textContent))
      .toEqual(["America", "and"]);
    expect(document.querySelector(".is-typeahead-dimmed")?.textContent).toBe("Japan");

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true })));
    expect(document.querySelector("#answer-value")?.textContent).toBe('"America"');
    expect(onAnswerActivate).toHaveBeenCalledTimes(1);
    expect(onAnswerActivate).toHaveBeenLastCalledWith("America");

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true })));
    expect(document.querySelector("#answer-value")?.textContent).toBe('"America"');
    expect(document.querySelector(".answer-composer")?.getAttribute("data-typeahead-active")).toBe("true");
    await act(async () => vi.advanceTimersByTime(1_500));

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })));
    expect(document.querySelector("#answer-value")?.textContent).toBe('""');
    expect(onAnswerActivate).toHaveBeenCalledTimes(1);

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(document.querySelector(".is-typeahead-match")).toBeNull();
    expect(document.querySelector(".is-typeahead-dimmed")).toBeNull();
  });

  it("reschedules an active word-bank prefix when the typeahead setting changes", async () => {
    vi.useFakeTimers();
    const question: LessonQuestion = {
      id: "typeahead-setting",
      type: "freeWriting",
      prompt: "Write",
      explanation: "Write",
      evaluationMode: "ai",
      minWords: 1,
      maxWords: 20,
      rubric: ["Clarity"],
      answerBank: {
        tokens: [
          { id: "america", label: "America" },
          { id: "and", label: "and" },
          { id: "japan", label: "Japan" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await render(createElement(Harness, { question, inputMode: "bank", typeaheadResetMs: 10_000 }));
    const composer = document.querySelector<HTMLElement>(".answer-composer")!;

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(document.querySelectorAll(".is-typeahead-match")).toHaveLength(2);

    await act(async () => root!.render(createElement(Harness, {
      question,
      inputMode: "bank",
      typeaheadResetMs: 1_000,
    })));
    await act(async () => vi.advanceTimersByTime(999));
    expect(document.querySelectorAll(".is-typeahead-match")).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(1));
    expect(document.querySelector(".is-typeahead-match")).toBeNull();
  });

  it("uses intrinsic inline-blank measurement instead of a fixed character width", async () => {
    const question: LessonQuestion = {
      id: "intrinsic-japanese-blank",
      type: "fillBlank",
      prompt: "Complete the sentence",
      targetPrompt: "私は{{blank:object}}を飲みます。",
      explanation: "Tea completes the sentence.",
      evaluationMode: "local",
      template: "私は{{blank:object}}を飲みます。",
      acceptedAnswers: ["お茶"],
    };
    await render(createElement(Harness, { question, inputMode: "keyboard" }));

    const blank = document.querySelector<HTMLElement>(".multi-cloze-inline-blank")!;
    expect(blank.style.width).toBe("");
    expect(blank.querySelector(".multi-cloze-blank-measure")?.textContent).toBe("");
    const input = blank.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "typed answer");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(blank.querySelector(".multi-cloze-blank-measure")?.textContent).toBe("typed answer");
  });

  it("applies the configured typeahead timeout to an inline-cloze word bank", async () => {
    vi.useFakeTimers();
    const question: LessonQuestion = {
      id: "inline-typeahead-setting",
      type: "fillBlank",
      prompt: "Complete the sentence",
      targetPrompt: "Visit {{blank:place}}.",
      explanation: "Choose a place.",
      evaluationMode: "local",
      template: "Visit {{blank:place}}.",
      acceptedAnswers: ["America"],
      answerBank: {
        tokens: [
          { id: "america", label: "America" },
          { id: "amsterdam", label: "Amsterdam" },
          { id: "japan", label: "Japan" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await render(createElement(Harness, {
      question,
      inputMode: "bank",
      typeaheadResetMs: 1_000,
    }));
    const response = document.querySelector<HTMLElement>(".multi-cloze-response")!;

    await act(async () => response.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    expect(document.querySelectorAll(".multi-cloze-bank .is-typeahead-match")).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(999));
    expect(document.querySelectorAll(".multi-cloze-bank .is-typeahead-match")).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(1));
    expect(document.querySelector(".multi-cloze-bank .is-typeahead-match")).toBeNull();
  });

  it("accepts a bank-token drop inside the expanded tray hitbox", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const question: LessonQuestion = {
      id: "drag-writing",
      type: "freeWriting",
      prompt: "Write",
      explanation: "Write",
      evaluationMode: "ai",
      minWords: 1,
      maxWords: 20,
      rubric: ["Clarity"],
      answerBank: {
        tokens: [{ id: "america", label: "America" }],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await render(createElement(Harness, { question, inputMode: "bank" }));
    const tray = document.querySelector<HTMLElement>(".answer-tray")!;
    const bank = document.querySelector<HTMLElement>(".token-bank")!;
    const token = bank.querySelector<HTMLButtonElement>("button")!;
    const rect = (left: number, top: number, width: number, height: number) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
    tray.getBoundingClientRect = () => rect(0, 0, 200, 40);
    bank.getBoundingClientRect = () => rect(0, 120, 200, 40);
    token.getBoundingClientRect = () => rect(20, 120, 80, 40);

    await act(async () => {
      token.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 30, clientY: 130 }));
      token.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 65 }));
      token.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 65 }));
    });

    expect(document.querySelector("#answer-value")?.textContent).toBe('"America"');
  });

  it("uses the visual wrapped row when reordering a dragged answer token", async () => {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    const question: LessonQuestion = {
      id: "wrapped-reorder",
      type: "reorderTokens",
      prompt: "Order the words",
      explanation: "Visual order",
      evaluationMode: "local",
      tokens: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
        { id: "d", label: "D" },
      ],
      correctOrderIds: ["b", "c", "a", "d"],
    };
    await render(createElement(Harness, { question }));
    for (const label of ["A", "B", "C", "D"]) await act(async () => button(label).click());
    const tray = document.querySelector<HTMLElement>(".answer-tray")!;
    const bank = document.querySelector<HTMLElement>(".token-bank")!;
    const tokens = Object.fromEntries(
      Array.from(tray.querySelectorAll<HTMLButtonElement>("[data-answer-token-id]"))
        .map((token) => [token.dataset.answerTokenId!, token]),
    );
    const rect = (left: number, top: number, width = 60, height = 36) => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
    tray.getBoundingClientRect = () => rect(0, 0, 220, 180);
    bank.getBoundingClientRect = () => rect(0, 260, 220, 40);
    tokens.a.getBoundingClientRect = () => rect(0, 0);
    tokens.b.getBoundingClientRect = () => rect(80, 0);
    tokens.c.getBoundingClientRect = () => rect(0, 100);
    tokens.d.getBoundingClientRect = () => rect(80, 100);

    await act(async () => tokens.a.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 20,
      clientY: 20,
    })));
    await act(async () => tokens.a.dispatchEvent(new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 75,
      clientY: 115,
    })));
    expect(document.querySelector(".answer-insertion-gap")).not.toBeNull();
    await act(async () => tokens.a.dispatchEvent(new MouseEvent("pointerup", {
      bubbles: true,
      clientX: 75,
      clientY: 115,
    })));

    expect(document.querySelector("#answer-value")?.textContent).toBe('["b","c","a","d"]');
  });

  it("marks answer text interactive only after evaluation", async () => {
    const question: LessonQuestion = {
      id: "choice",
      type: "singleChoice",
      prompt: "Choose",
      explanation: "Choice",
      evaluationMode: "local",
      options: [{ id: "water", label: "water" }, { id: "tea", label: "tea" }],
      correctOptionId: "water",
    };
    await render(createElement(Harness, { question }));
    expect(Array.from(document.querySelectorAll("[data-answer-interactive]")).every((node) => node.getAttribute("data-answer-interactive") === "false")).toBe(true);
    await act(async () => root!.render(createElement(Harness, { question, evaluated: true })));
    expect(Array.from(document.querySelectorAll("[data-answer-interactive]")).every((node) => node.getAttribute("data-answer-interactive") === "true")).toBe(true);
  });

  it("moves a Select Blank option into an inline slot and leaves a bank placeholder", async () => {
    const question: LessonQuestion = {
      id: "select-blank",
      type: "selectBlank",
      prompt: "Choose the missing word",
      explanation: "Water is the object.",
      evaluationMode: "local",
      template: "私は{{blank}}を飲みます。",
      options: [
        { id: "water", label: "水" },
        { id: "tea", label: "お茶" },
      ],
      correctOptionId: "water",
    };
    await render(createElement(Harness, { question }));
    expect(document.querySelector(".select-blank-response")?.textContent).not.toContain("Choose");

    await act(async () => button("水").click());
    expect(document.querySelector(".select-blank-slot.is-filled")?.textContent).toContain("水");
    expect(document.querySelectorAll(".select-blank-option-placeholder")).toHaveLength(1);
    expect(document.querySelector("#answer-value")?.textContent).toBe('"water"');

    await act(async () => document.querySelector<HTMLButtonElement>(".select-blank-slot.is-filled")!.click());
    expect(document.querySelector(".select-blank-slot.is-filled")).toBeNull();
    expect(document.querySelectorAll(".select-blank-options button")).toHaveLength(2);
    expect(document.querySelector("#answer-value")?.textContent).toBe('""');
  });

  it("places a Fill Blank bank token directly inside its inline marker", async () => {
    const question: LessonQuestion = {
      id: "fill-inline",
      type: "fillBlank",
      prompt: "Complete the sentence",
      targetPrompt: "I drink {{blank:object}} daily.",
      explanation: "Water is the object.",
      evaluationMode: "local",
      template: "I drink {{blank:object}} daily.",
      acceptedAnswers: ["water"],
      answerBank: {
        tokens: [{ id: "water", label: "water" }, { id: "tea", label: "tea" }],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await render(createElement(Harness, { question, inputMode: "bank" }));
    const blank = document.querySelector<HTMLElement>(".multi-cloze-inline-blank")!;
    expect(blank.style.width).toBe("");

    await act(async () => button("water").click());
    expect(blank.textContent).toContain("water");
    expect(document.querySelector("#answer-value")?.textContent).toBe('"water"');
    expect(document.querySelectorAll(".multi-cloze-bank .token-bank-placeholder")).toHaveLength(1);

    await act(async () => blank.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('""');
    expect(document.querySelectorAll(".multi-cloze-bank button")).toHaveLength(2);
  });

  it("fills explicit multi-blank markers in active order and returns a selected token", async () => {
    const question: LessonQuestion = {
      id: "multi-bank",
      type: "multiCloze",
      prompt: "Complete both blanks",
      targetPrompt: "{{blank:subject}} drinks {{blank:object}}.",
      template: "{{blank:subject}} drinks {{blank:object}}.",
      explanation: "A complete sentence.",
      evaluationMode: "local",
      blanks: [
        { id: "subject", acceptedAnswers: ["I"] },
        { id: "object", acceptedAnswers: ["water"] },
      ],
      answerBank: {
        tokens: [
          { id: "i", label: "I" },
          { id: "water", label: "water" },
          { id: "tea", label: "tea" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    };
    await render(createElement(Harness, { question, inputMode: "bank" }));

    await act(async () => button("I").click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('{"subject":"I","object":""}');
    expect(document.querySelectorAll(".multi-cloze-inline-blank.is-filled")).toHaveLength(1);
    expect(document.querySelectorAll(".token-bank-placeholder")).toHaveLength(1);

    await act(async () => button("water").click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('{"subject":"I","object":"water"}');
    expect(document.querySelectorAll(".multi-cloze-inline-blank.is-filled")).toHaveLength(2);

    await act(async () => document.querySelector<HTMLButtonElement>('[data-multi-cloze-token="i"]')!.click());
    expect(document.querySelector("#answer-value")?.textContent).toBe('{"subject":"","object":"water"}');
    expect(document.querySelectorAll(".multi-cloze-inline-blank.is-filled")).toHaveLength(1);
  });

  it("keeps categories reusable and completes after every item is locked", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const question: LessonQuestion = {
      id: "categorize",
      type: "categorize",
      prompt: "Categorize",
      explanation: "Group the words.",
      evaluationMode: "local",
      categories: [
        { id: "warm", label: "Warm colors" },
        { id: "cool", label: "Cool colors" },
      ],
      items: [
        { id: "red", label: "red", categoryId: "warm" },
        { id: "orange", label: "orange", categoryId: "warm" },
        { id: "blue", label: "blue", categoryId: "cool" },
      ],
    };
    await render(createElement(Harness, { question, onComplete }));

    expect(Array.from(document.querySelectorAll<HTMLElement>(".categorize-matching [data-lesson-hotkey-index]"))
      .map((element) => element.dataset.lessonHotkeyIndex))
      .toEqual(["1", "2", "3", "4", "5"]);
    expect(Array.from(document.querySelectorAll(".categorize-matching .pair-index")).map((element) => element.textContent))
      .toEqual(["1", "2", "3", "4", "5"]);

    await act(async () => button("red").click());
    await act(async () => button("Warm colors").click());
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(2);
    expect(button("Warm colors").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(349));
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(1));
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(0);
    expect(button("Warm colors").disabled).toBe(false);

    await act(async () => button("orange").click());
    await act(async () => button("Warm colors").click());
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(350));
    expect(button("Warm colors").disabled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => button("blue").click());
    await act(async () => button("Cool colors").click());

    expect(document.querySelectorAll(".categorize-items button.is-locked")).toHaveLength(3);
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(2);
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(350));
    expect(document.querySelectorAll(".categorize-matching button.is-match-correct")).toHaveLength(0);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ red: "warm", orange: "warm", blue: "cool" });
  });

  it("renders reordered dialogue as speaker-labelled chat and speaks only the utterance", async () => {
    const onAnswerActivate = vi.fn();
    const question: LessonQuestion = {
      id: "dialogue",
      type: "reorderDialogue",
      prompt: "Order the dialogue",
      explanation: "A short exchange.",
      evaluationMode: "local",
      turns: [
        { id: "hello", speaker: "Aki", label: "Good morning." },
        { id: "reply", speaker: "Mina", label: "Good morning, Aki." },
      ],
      correctOrderIds: ["hello", "reply"],
    };
    await render(createElement(Harness, { question, onAnswerActivate }));

    expect(document.querySelectorAll(".dialogue-bank-turn")).toHaveLength(2);
    expect(document.querySelector(".dialogue-turn")).toBeNull();

    await act(async () => button("Good morning.").click());
    expect(document.querySelectorAll(".dialogue-turn")).toHaveLength(1);
    expect(document.querySelectorAll(".dialogue-bank-turn")).toHaveLength(1);
    await act(async () => button("Good morning, Aki.").click());
    expect(document.querySelector(".dialogue-turn.is-left small")?.textContent).toBe("Aki");
    expect(document.querySelector(".dialogue-turn.is-right small")?.textContent).toBe("Mina");
    expect(onAnswerActivate).toHaveBeenNthCalledWith(1, "Good morning.");
    expect(onAnswerActivate).toHaveBeenNthCalledWith(2, "Good morning, Aki.");
  });

  it("uses vertical midpoints for dialogue insertion before the first and after the last turn", () => {
    const rects = [
      { top: 100, height: 50 },
      { top: 180, height: 50 },
      { top: 260, height: 50 },
    ];
    expect(verticalInsertionIndex(rects, 40)).toBe(0);
    expect(verticalInsertionIndex(rects, 175)).toBe(1);
    expect(verticalInsertionIndex(rects, 245)).toBe(2);
    expect(verticalInsertionIndex(rects, 400)).toBe(3);
  });

  it("keeps the Flashcard Recall voice control visible when recognition is unavailable", async () => {
    const question: LessonQuestion = {
      id: "flashcard",
      type: "flashcardRecall",
      prompt: "Recall the word",
      explanation: "Water.",
      evaluationMode: "local",
      cue: "water",
      acceptedAnswers: ["水"],
    };
    await render(createElement(Harness, { question }));
    const voiceButton = button("Use voice");
    expect(voiceButton.disabled).toBe(true);
    expect(voiceButton.title).toContain("not available");
    expect(document.body.textContent).toContain("Continue with the keyboard");
  });

  it("renders stable but content-specific audio waveforms", async () => {
    await render(createElement("div", null,
      createElement(AudioWaveform, { text: "水" }),
      createElement(AudioWaveform, { text: "お茶" }),
      createElement(AudioWaveform, { text: "水" }),
    ));
    const waves = Array.from(document.querySelectorAll(".audio-waveform")).map((wave) => (
      Array.from(wave.children).map((bar) => (bar as HTMLElement).style.height)
    ));
    expect(waves[0]).toEqual(waves[2]);
    expect(waves[0]).not.toEqual(waves[1]);
  });

  it("does not open a glossary tooltip for a locked answer", async () => {
    const onTermActivate = vi.fn();
    await render(createElement(GlossaryText, {
      text: "water",
      glossary: [{ term: "water", meaning: "nước" }],
      tooltipsEnabled: true,
      interactive: false,
      onTermActivate,
    }));
    const term = document.querySelector<HTMLElement>(".glossary-pronunciation")!;
    await act(async () => term.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".glossary-tooltip")).toBeNull();
    expect(onTermActivate).not.toHaveBeenCalled();

    await act(async () => root!.render(createElement(GlossaryText, {
      text: "water",
      glossary: [{ term: "water", meaning: "nước" }],
      tooltipsEnabled: true,
      interactive: true,
      onTermActivate,
    })));
    await act(async () => document.querySelector<HTMLElement>(".glossary-term")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(document.querySelector(".glossary-tooltip")?.textContent).toContain("nước");
    expect(onTermActivate).toHaveBeenCalledWith("water");
  });

  it("marks only interactive lexical segments as independently underlined glossary terms", async () => {
    const text = "\u79c1\u306f\u6c34\u3092\u98f2\u307f\u307e\u3059\u3002";
    const glossary = [
      { term: "\u79c1", meaning: "I" },
      { term: "\u306f", meaning: "topic marker" },
      { term: "\u6c34", meaning: "water" },
      { term: "\u3092", meaning: "object marker" },
      { term: "\u98f2\u307f\u307e\u3059", meaning: "drink" },
    ];
    await render(createElement(GlossaryText, {
      text,
      glossary,
      tooltipsEnabled: true,
      interactive: true,
      segmentationMode: "lexical-cjk",
    }));

    expect(Array.from(document.querySelectorAll(".glossary-term")).map((term) => term.textContent))
      .toEqual(["\u79c1", "\u306f", "\u6c34", "\u3092", "\u98f2\u307f\u307e\u3059"]);
    const punctuation = Array.from(document.querySelectorAll<HTMLElement>("#mount > span"))
      .find((segment) => segment.textContent === "\u3002");
    expect(punctuation?.className).toBe("");

    await act(async () => root!.render(createElement(GlossaryText, {
      text,
      glossary,
      tooltipsEnabled: true,
      interactive: false,
      segmentationMode: "lexical-cjk",
    })));
    expect(document.querySelectorAll(".glossary-term")).toHaveLength(0);
    expect(document.querySelectorAll(".glossary-pronunciation")).toHaveLength(5);
  });
});
