// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterTracingResponse, characterCenterOffset } from "./CharacterTracingResponse";
import type { CharacterTracingQuestion, QuestionAnswer } from "./types";

const mocks = vi.hoisted(() => {
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
    create: vi.fn((target: HTMLElement) => (
      target.classList.contains("hanzi-writer-animation-target") ? animationWriter : writer
    )),
    animationWriter,
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

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function revealedProgressCellCount(): number {
  return Array.from(document.querySelectorAll<SVGPathElement>(".stroke-guide-progress-cell"))
    .filter((cell) => cell.dataset.revealed === "true").length;
}

async function renderTracing(
  strokeTolerance?: number,
  showStrokeGuide?: boolean,
  actions: {
    onChange?: (answer: QuestionAnswer) => void;
    onSpeak?: (character: string) => void;
  } = {},
) {
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(CharacterTracingResponse, {
      question,
      language: "Japanese",
      answer: "",
      onChange: actions.onChange ?? vi.fn(),
      strokeTolerance,
      showStrokeGuide,
      onSpeak: actions.onSpeak,
    }));
  });
  await vi.waitFor(() => expect(mocks.writer.quiz).toHaveBeenCalled());
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mocks.create.mockClear();
  mocks.writer.cancelQuiz.mockClear();
  mocks.writer.hideCharacter.mockReset().mockResolvedValue(undefined);
  mocks.writer.quiz.mockReset().mockResolvedValue(undefined);
  mocks.animationWriter.animateStroke.mockReset().mockResolvedValue({ canceled: false });
  mocks.animationWriter.hideCharacter.mockReset().mockResolvedValue(undefined);
  mocks.animationWriter.updateColor.mockReset().mockResolvedValue(undefined);
  mocks.loadStrokeCharacterData.mockReset().mockResolvedValue({
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
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("CharacterTracingResponse", () => {
  it("places manual pronunciation before the glyph without embedding Letter settings", async () => {
    const onSpeak = vi.fn();
    await renderTracing(undefined, undefined, { onSpeak });

    const speaker = document.querySelector<HTMLButtonElement>(
      `[aria-label="Play ${question.character} pronunciation"]`,
    );
    const settings = document.querySelector<HTMLButtonElement>('[aria-label="Open Letter settings"]');
    const identity = document.querySelector(".character-tracing-identity");
    expect(speaker).not.toBeNull();
    expect(settings).toBeNull();
    expect(identity?.firstElementChild).toBe(speaker);
    expect(speaker?.nextElementSibling?.classList.contains("character-tracing-glyph")).toBe(true);

    await act(async () => speaker!.click());

    expect(onSpeak).toHaveBeenCalledWith(question.character);
  });

  it("keeps accepted strokes mounted when completion disables the response", async () => {
    const onChange = vi.fn();
    await renderTracing(undefined, undefined, { onChange });
    const createdWriters = mocks.create.mock.calls.length;
    const quizOptions = mocks.writer.quiz.mock.calls[0][0];

    await act(async () => quizOptions.onComplete());
    expect(onChange).toHaveBeenCalledWith("passed");

    await act(async () => {
      root!.render(createElement(CharacterTracingResponse, {
        question,
        language: "Japanese",
        answer: "passed",
        disabled: true,
        onChange,
      }));
    });

    expect(mocks.create).toHaveBeenCalledTimes(createdWriters);
    expect(mocks.writer.hideCharacter).not.toHaveBeenCalled();
    expect(document.querySelector(".hanzi-writer-target")?.classList.contains("is-disabled")).toBe(true);
    expect(document.querySelector(".tracing-instruction [role=status]")?.textContent).toBe("Tracing complete.");
  });

  it("uses the live stroke-order override instead of the stored question value", async () => {
    document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
    root = createRoot(document.querySelector("#mount")!);
    await act(async () => {
      root!.render(createElement(CharacterTracingResponse, {
        question,
        language: "Japanese",
        answer: "",
        requireStrokeOrder: false,
        onChange: vi.fn(),
      }));
    });

    await vi.waitFor(() => expect(document.querySelector(".tracing-canvas-stack")).not.toBeNull());
    expect(mocks.writer.quiz).not.toHaveBeenCalled();
  });

  it("passes the configured tolerance to the quiz and reports misses", async () => {
    await renderTracing(1.7);
    const quizOptions = mocks.writer.quiz.mock.calls[0][0];
    expect(quizOptions).toMatchObject({
      leniency: 1.7,
      averageDistanceThreshold: 500,
      showHintAfterMisses: false,
      markStrokeCorrectAfterMisses: 4,
      highlightOnComplete: true,
    });
    expect(document.querySelector(".tracing-instruction [role=status]")?.textContent)
      .toContain("repeated attempts will advance");

    await act(async () => quizOptions.onMistake({
      strokeNum: 0,
      mistakesOnStroke: 3,
    }));
    expect(document.querySelector(".tracing-instruction [role=status]")?.textContent)
      .toContain("Miss 3");
    await vi.waitFor(() => expect(mocks.animationWriter.animateStroke).toHaveBeenCalledWith(0));
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
    await vi.waitFor(() => expect(mocks.animationWriter.animateStroke).toHaveBeenCalledWith(0));
    await vi.waitFor(() => expect(mocks.writer.quiz).toHaveBeenCalledTimes(2));
    expect(mocks.writer.quiz.mock.calls[1][0]).toMatchObject({
      leniency: 1,
      averageDistanceThreshold: 500,
      markStrokeCorrectAfterMisses: false,
    });
    expect(button("Animate strokes").disabled).toBe(false);
  });

  it("shows the current stroke direction guide and can hide it", async () => {
    mocks.loadStrokeCharacterData.mockResolvedValueOnce({
      logicalData: {
        strokes: ["first", "second"],
        medians: [
          [[100, 100], [300, 100]],
          [[200, 300], [200, 500]],
        ],
      },
      animationData: {
        strokes: ["first", "second"],
        medians: [
          [[100, 100], [300, 100]],
          [[200, 300], [200, 500]],
        ],
      },
      animationGroups: [[0], [1]],
    });
    await renderTracing();
    const firstPath = document.querySelector(".stroke-guide-path")?.getAttribute("d");
    const progressCells = document.querySelector<SVGGElement>(".stroke-guide-progress-cells");
    const guide = document.querySelector<SVGSVGElement>(".stroke-guide");
    const grid = document.querySelector<HTMLDivElement>(".tracing-grid");
    expect(firstPath).toBeTruthy();
    expect(revealedProgressCellCount()).toBe(0);
    expect(progressCells?.getAttribute("clip-path")).toMatch(/^url\(#stroke-guide-clip-/);

    vi.spyOn(guide!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 280,
      bottom: 280,
      width: 280,
      height: 280,
      toJSON: () => ({}),
    });
    grid!.dispatchEvent(pointerEvent("pointerdown", 40.2, 209.8));
    grid!.dispatchEvent(pointerEvent("pointermove", 64.4, 209.8));
    await vi.waitFor(() => {
      expect(revealedProgressCellCount()).toBeGreaterThan(0);
    });
    const progressBeforeLeavingGuide = revealedProgressCellCount();
    grid!.dispatchEvent(pointerEvent("pointermove", 270, 10));
    await vi.waitFor(() => expect(revealedProgressCellCount()).toBe(progressBeforeLeavingGuide));

    window.dispatchEvent(pointerEvent("pointerup", 64.4, 209.8));
    await vi.waitFor(() => expect(revealedProgressCellCount()).toBe(0));

    await act(async () => mocks.writer.quiz.mock.calls[0][0].onCorrectStroke({
      strokeNum: 0,
      strokesRemaining: 1,
    }));
    expect(document.querySelector(".stroke-guide-path")?.getAttribute("d")).not.toBe(firstPath);
    expect(revealedProgressCellCount()).toBe(0);

    await act(async () => root?.unmount());
    root = null;
    await renderTracing(undefined, false);
    expect(document.querySelector(".stroke-guide")).toBeNull();
  });

  it("animates technical path parts continuously inside their logical stroke group", async () => {
    mocks.loadStrokeCharacterData.mockResolvedValueOnce({
      logicalData: {
        strokes: ["first", "second", "third-a third-b"],
        medians: [
          [[100, 100], [300, 100]],
          [[200, 200], [300, 300]],
          [[300, 300], [500, 500]],
        ],
      },
      animationData: {
        strokes: ["first", "second", "third-a", "third-b"],
        medians: [
          [[100, 100], [300, 100]],
          [[200, 200], [300, 300]],
          [[300, 300], [500, 500]],
          [[300, 300], [500, 500]],
        ],
      },
      animationGroups: [[0], [1], [2, 3]],
    });
    await renderTracing();
    vi.useFakeTimers();

    await act(async () => button("Animate strokes").click());
    expect(mocks.animationWriter.animateStroke.mock.calls.map(([index]) => index)).toEqual([0]);

    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(mocks.animationWriter.animateStroke.mock.calls.map(([index]) => index)).toEqual([0, 1]);

    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(mocks.animationWriter.animateStroke.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3]);
  });

  it("loops stroke animation on request and returns to the quiz when stopped", async () => {
    mocks.animationWriter.animateStroke.mockReturnValueOnce(new Promise(() => {}));
    await renderTracing();
    const loop = document.querySelector<HTMLInputElement>(".tracing-animation-controls input");
    expect(loop).not.toBeNull();

    await act(async () => loop!.click());
    await act(async () => button("Animate strokes").click());

    expect(mocks.animationWriter.animateStroke).toHaveBeenCalledTimes(1);
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
