// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlossaryText } from "./GlossaryText";
import { AudioWaveform, QuestionRenderer, type AnswerInputMode } from "./QuestionRenderer";
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
  onAnswerActivate,
}: {
  question: LessonQuestion;
  evaluated?: boolean;
  inputMode?: AnswerInputMode;
  onAnswerActivate?: (text: string) => void;
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
      onChange: setAnswer,
      onAnswerActivate,
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
    expect(document.querySelectorAll(".pair-column > button.is-locked")).toHaveLength(2);
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

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })));
    expect(document.querySelector("#answer-value")?.textContent).toBe('""');
    expect(onAnswerActivate).toHaveBeenCalledTimes(1);

    await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })));
    await act(async () => vi.advanceTimersByTime(1_500));
    expect(document.querySelector(".is-typeahead-match")).toBeNull();
    expect(document.querySelector(".is-typeahead-dimmed")).toBeNull();
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
});
