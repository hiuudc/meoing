// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterTracingResponse } from "./CharacterTracingResponse";
import type { CharacterTracingQuestion } from "./types";

const mocks = vi.hoisted(() => {
  const writer = {
    animateCharacter: vi.fn(),
    cancelQuiz: vi.fn(),
    quiz: vi.fn(),
  };
  return {
    create: vi.fn(() => writer),
    loadStrokeCharacterData: vi.fn(),
    writer,
  };
});

vi.mock("hanzi-writer", () => ({
  default: { create: mocks.create },
}));

vi.mock("./strokeData", () => ({
  loadStrokeCharacterData: mocks.loadStrokeCharacterData,
}));

const question: CharacterTracingQuestion = {
  id: "trace-a",
  type: "characterTracing",
  prompt: "Trace the character",
  explanation: "Follow the stroke order.",
  evaluationMode: "local",
  character: "あ",
  reading: "a",
  requireStrokeOrder: true,
};

let root: Root | null = null;

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function renderTracing(strokeTolerance?: number) {
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(CharacterTracingResponse, {
      question,
      language: "Japanese",
      answer: "",
      onChange: vi.fn(),
      strokeTolerance,
    }));
  });
  await vi.waitFor(() => expect(mocks.writer.quiz).toHaveBeenCalled());
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mocks.create.mockClear();
  mocks.writer.cancelQuiz.mockClear();
  mocks.writer.quiz.mockReset().mockResolvedValue(undefined);
  mocks.writer.animateCharacter.mockReset().mockImplementation((options?: { onComplete?: (result: { canceled: boolean }) => void }) => {
    options?.onComplete?.({ canceled: false });
    return Promise.resolve();
  });
  mocks.loadStrokeCharacterData.mockReset().mockResolvedValue({
    strokes: ["M 0 0 L 100 100"],
    medians: [[[0, 0], [100, 100]]],
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("CharacterTracingResponse", () => {
  it("passes the configured tolerance to the quiz and reports misses", async () => {
    await renderTracing(1.7);
    const quizOptions = mocks.writer.quiz.mock.calls[0][0];
    expect(quizOptions).toMatchObject({
      leniency: 1.7,
      showHintAfterMisses: 2,
      highlightOnComplete: true,
    });

    await act(async () => quizOptions.onMistake({
      strokeNum: 2,
      mistakesOnStroke: 3,
    }));
    expect(document.querySelector(".tracing-instruction [role=status]")?.textContent)
      .toContain("Miss 3");
  });

  it("defaults legacy tracing to tolerance one and restarts after animation", async () => {
    await renderTracing();
    expect(mocks.writer.quiz.mock.calls[0][0]).toMatchObject({ leniency: 1 });

    await act(async () => button("Animate strokes").click());

    expect(mocks.writer.cancelQuiz).toHaveBeenCalledTimes(1);
    expect(mocks.writer.animateCharacter).toHaveBeenCalledTimes(1);
    expect(mocks.writer.quiz).toHaveBeenCalledTimes(2);
    expect(mocks.writer.quiz.mock.calls[1][0]).toMatchObject({ leniency: 1 });
    expect(button("Animate strokes").disabled).toBe(false);
  });
});
