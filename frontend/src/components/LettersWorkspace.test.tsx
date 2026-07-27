// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lettersPracticeExerciseCount } from "../learning/lettersPractice";
import { LettersLessonIntro, LettersPractice } from "./LettersWorkspace";

vi.mock("../learning/CharacterTracingResponse", () => ({
  CharacterTracingResponse: ({ question }: { question: { character: string } }) => (
    <div data-testid="mock-tracing">{question.character}</div>
  ),
}));

const practiceCharacters = Array.from(
  { length: 10 },
  (_, index) => String.fromCodePoint(0x3042 + index * 2),
);

let root: Root | null = null;
let spoken: TestSpeechUtterance[] = [];

class TestSpeechUtterance {
  lang = "";
  rate = 1;
  text: string;

  constructor(text: string) {
    this.text = text;
  }
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => (
      candidate.textContent?.includes(label) || candidate.getAttribute("aria-label") === label
    ));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function IntroHarness() {
  const [open, setOpen] = useState(false);
  const [savedCount, setSavedCount] = useState(5);
  const [draftCount, setDraftCount] = useState(5);
  const selected = practiceCharacters.slice(0, draftCount);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraftCount(savedCount);
          setOpen(true);
        }}
      >
        Open Learn
      </button>
      <output id="saved-practice-count">{savedCount}</output>
      <LettersLessonIntro
        open={open}
        language="Japanese"
        scriptLabel="Hiragana"
        characters={selected}
        metadata={new Map()}
        characterCount={draftCount}
        exerciseCount={lettersPracticeExerciseCount(selected.length)}
        maxCharacterCount={10}
        onCharacterCountChange={setDraftCount}
        onClose={() => setOpen(false)}
        onExited={() => undefined}
        onStart={() => {
          setSavedCount(draftCount);
          setOpen(false);
        }}
      />
    </>
  );
}

async function setNumberInput(input: HTMLInputElement, value: number) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function finishIntroExit() {
  const panel = document.querySelector<HTMLElement>(".letters-lesson-intro");
  if (!panel) return;
  await act(async () => panel.dispatchEvent(new Event("animationend", { bubbles: true })));
}

beforeEach(() => {
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
  root = createRoot(document.querySelector("#mount")!);
  spoken = [];
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: TestSpeechUtterance,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: TestSpeechUtterance) => spoken.push(utterance)),
    },
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Letters lesson intro", () => {
  it("clamps and previews a custom character count, then saves it only when the lesson starts", async () => {
    await act(async () => root!.render(createElement(IntroHarness)));
    for (const dismiss of ["button", "escape", "overlay"] as const) {
      await act(async () => button("Open Learn").click());
      const input = document.querySelector<HTMLInputElement>("#letters-practice-character-count")!;
      expect(input.value).toBe("5");
      expect(document.querySelectorAll(".letters-lesson-character-list article")).toHaveLength(5);
      expect(document.body.textContent).toContain("21 exercises before retries");

      await setNumberInput(input, 99);
      expect(input.value).toBe("10");
      expect(document.querySelectorAll(".letters-lesson-character-list article")).toHaveLength(10);
      expect(document.body.textContent).toContain("42 exercises before retries");
      await setNumberInput(input, 0);
      expect(input.value).toBe("1");
      expect(document.querySelectorAll(".letters-lesson-character-list article")).toHaveLength(1);
      expect(document.body.textContent).toContain("5 exercises before retries");
      await setNumberInput(input, 7);

      if (dismiss === "button") {
        await act(async () => button("Not now").click());
      } else if (dismiss === "escape") {
        await act(async () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
      } else {
        const backdrop = document.querySelector<HTMLElement>(".letters-lesson-intro-backdrop");
        if (!backdrop) throw new Error("Letters lesson backdrop not found.");
        await act(async () => {
          backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        });
      }
      await finishIntroExit();
      expect(document.querySelector("#saved-practice-count")?.textContent).toBe("5");
    }

    await act(async () => button("Open Learn").click());
    expect(document.querySelector<HTMLInputElement>("#letters-practice-character-count")?.value).toBe("5");
    await setNumberInput(
      document.querySelector<HTMLInputElement>("#letters-practice-character-count")!,
      7,
    );
    await act(async () => button("Start lesson").click());
    expect(document.querySelector("#saved-practice-count")?.textContent).toBe("7");
  });

  it("places each speaker before its glyph and reads with the target locale", async () => {
    await act(async () => root!.render(createElement(IntroHarness)));
    await act(async () => button("Open Learn").click());
    const firstRow = document.querySelector(".letters-lesson-character-list article")!;
    const speaker = firstRow.querySelector<HTMLButtonElement>("button")!;
    const glyph = firstRow.querySelector("strong");

    expect(firstRow.firstElementChild).toBe(speaker);
    expect(speaker.nextElementSibling).toBe(glyph);
    await act(async () => speaker.click());
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ text: practiceCharacters[0], lang: "ja-JP", rate: 0.82 });
  });
});

describe("Standalone Letters trace", () => {
  it("auto-speaks on entry, character changes, and Retry without replaying settings resets", async () => {
    const onSpeak = vi.fn();
    const onOpenSettings = vi.fn();
    const props = {
      characters: practiceCharacters.slice(0, 2),
      character: practiceCharacters[0],
      language: "Japanese",
      requireStrokeOrder: true,
      showStrokeGuide: true,
      strokeTolerance: 1,
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onStart: vi.fn(),
      onMastered: vi.fn(),
      onSpeak,
      onOpenSettings,
      settingsActive: false,
      settingsRevision: 0,
    };

    await act(async () => root!.render(createElement(LettersPractice, props)));
    expect(onSpeak).toHaveBeenCalledTimes(1);
    expect(onSpeak).toHaveBeenLastCalledWith(practiceCharacters[0]);

    const settings = button("Open Letter settings");
    expect(settings.closest(".letters-practice-header-actions")).not.toBeNull();
    await act(async () => settings.click());
    expect(onOpenSettings).toHaveBeenCalledWith(settings);

    await act(async () => root!.render(createElement(LettersPractice, {
      ...props,
      settingsRevision: 1,
    })));
    expect(onSpeak).toHaveBeenCalledTimes(1);

    await act(async () => button("Retry").click());
    expect(onSpeak).toHaveBeenCalledTimes(2);

    await act(async () => root!.render(createElement(LettersPractice, {
      ...props,
      character: practiceCharacters[1],
      settingsRevision: 1,
    })));
    expect(onSpeak).toHaveBeenCalledTimes(3);
    expect(onSpeak).toHaveBeenLastCalledWith(practiceCharacters[1]);
  });
});
