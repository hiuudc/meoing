// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonPlayer } from "./LessonPlayer";
import type { Lesson } from "./types";

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

beforeEach(() => {
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
});
