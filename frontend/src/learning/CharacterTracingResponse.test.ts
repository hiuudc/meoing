// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterTracingResponse, characterCenterOffset } from "./CharacterTracingResponse";
import type { CharacterTracingQuestion } from "./types";

const mocks = vi.hoisted(() => {
  const writer = {
    animateCharacter: vi.fn(),
    cancelQuiz: vi.fn(),
    hideCharacter: vi.fn(),
    loopCharacterAnimation: vi.fn(),
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

async function renderTracing(strokeTolerance?: number, showStrokeGuide?: boolean) {
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(CharacterTracingResponse, {
      question,
      language: "Japanese",
      answer: "",
      onChange: vi.fn(),
      strokeTolerance,
      showStrokeGuide,
    }));
  });
  await vi.waitFor(() => expect(mocks.writer.quiz).toHaveBeenCalled());
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mocks.create.mockClear();
  mocks.writer.cancelQuiz.mockClear();
  mocks.writer.hideCharacter.mockReset().mockResolvedValue(undefined);
  mocks.writer.loopCharacterAnimation.mockReset().mockResolvedValue(undefined);
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
      averageDistanceThreshold: 500,
      showHintAfterMisses: 2,
      markStrokeCorrectAfterMisses: 4,
      highlightOnComplete: true,
    });
    expect(document.querySelector(".tracing-instruction [role=status]")?.textContent)
      .toContain("repeated attempts will advance");

    await act(async () => quizOptions.onMistake({
      strokeNum: 2,
      mistakesOnStroke: 3,
    }));
    expect(document.querySelector(".tracing-instruction [role=status]")?.textContent)
      .toContain("Miss 3");
  });

  it("defaults legacy tracing to tolerance one and restarts after animation", async () => {
    await renderTracing();
    expect(mocks.writer.quiz.mock.calls[0][0]).toMatchObject({
      leniency: 1,
      averageDistanceThreshold: 500,
      markStrokeCorrectAfterMisses: false,
    });

    await act(async () => button("Animate strokes").click());

    expect(mocks.writer.cancelQuiz).toHaveBeenCalledTimes(1);
    expect(mocks.writer.animateCharacter).toHaveBeenCalledTimes(1);
    expect(mocks.writer.quiz).toHaveBeenCalledTimes(2);
    expect(mocks.writer.quiz.mock.calls[1][0]).toMatchObject({
      leniency: 1,
      averageDistanceThreshold: 500,
      markStrokeCorrectAfterMisses: false,
    });
    expect(button("Animate strokes").disabled).toBe(false);
  });

  it("shows the current stroke direction guide and can hide it", async () => {
    mocks.loadStrokeCharacterData.mockResolvedValueOnce({
      strokes: ["first", "second"],
      medians: [
        [[100, 100], [300, 100]],
        [[200, 300], [200, 500]],
      ],
    });
    await renderTracing();
    const firstPoints = document.querySelector(".stroke-guide-path")?.getAttribute("points");
    expect(firstPoints).toBeTruthy();

    await act(async () => mocks.writer.quiz.mock.calls[0][0].onCorrectStroke({
      strokeNum: 0,
      strokesRemaining: 1,
    }));
    expect(document.querySelector(".stroke-guide-path")?.getAttribute("points")).not.toBe(firstPoints);

    await act(async () => root?.unmount());
    root = null;
    await renderTracing(undefined, false);
    expect(document.querySelector(".stroke-guide")).toBeNull();
  });

  it("loops stroke animation on request and returns to the quiz when stopped", async () => {
    mocks.writer.loopCharacterAnimation.mockReturnValueOnce(new Promise(() => {}));
    await renderTracing();
    const loop = document.querySelector<HTMLInputElement>(".tracing-animation-controls input");
    expect(loop).not.toBeNull();

    await act(async () => loop!.click());
    await act(async () => button("Animate strokes").click());

    expect(mocks.writer.loopCharacterAnimation).toHaveBeenCalledTimes(1);
    expect(button("Stop animation")).toBeTruthy();

    await act(async () => button("Stop animation").click());
    expect(mocks.writer.quiz).toHaveBeenCalledTimes(2);
  });

  it("calculates a bounded correction that centers median geometry in the grid", () => {
    const offset = characterCenterOffset({
      strokes: ["stroke"],
      medians: [[[412, 338], [512, 438]]],
    });
    expect(offset.x).toBeCloseTo(12.1, 1);
    expect(offset.y).toBeCloseTo(0, 1);

    expect(characterCenterOffset({
      strokes: ["stroke"],
      medians: [[[-2_000, 4_000], [-1_000, 5_000]]],
    })).toEqual({ x: 48, y: 48 });
  });
});
