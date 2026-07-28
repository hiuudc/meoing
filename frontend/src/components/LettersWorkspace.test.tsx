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
const practiceMetadata = new Map(
  practiceCharacters.map((character, index) => [character, { reading: `reading-${index + 1}` }]),
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
  const [mode, setMode] = useState<"auto" | "custom">("auto");
  const [autoStart, setAutoStart] = useState(0);
  const [customCharacters, setCustomCharacters] = useState<string[]>([]);
  const [customQuery, setCustomQuery] = useState("");
  const autoCharacters = Array.from(
    { length: draftCount },
    (_, index) => practiceCharacters[(autoStart + index) % practiceCharacters.length],
  );
  const selected = mode === "auto" ? autoCharacters : customCharacters;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraftCount(savedCount);
          setAutoStart(0);
          setMode("auto");
          setCustomCharacters([]);
          setCustomQuery("");
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
        metadata={practiceMetadata}
        characterCount={draftCount}
        exerciseCount={lettersPracticeExerciseCount(selected, practiceMetadata)}
        maxCharacterCount={10}
        availableCharacters={practiceCharacters}
        progress={{}}
        selectionMode={mode}
        customQuery={customQuery}
        canRefresh={draftCount < practiceCharacters.length}
        onCharacterCountChange={(count) => {
          setDraftCount(count);
          setAutoStart(0);
        }}
        onCustomQueryChange={setCustomQuery}
        onRefresh={() => setAutoStart((current) => (current + draftCount) % practiceCharacters.length)}
        onSelectionModeChange={(nextMode) => {
          setMode(nextMode);
          if (nextMode === "custom") {
            setCustomCharacters(autoCharacters);
            setCustomQuery("");
          }
        }}
        onToggleCustomCharacter={(character) => setCustomCharacters((current) => (
          current.includes(character)
            ? current.filter((candidate) => candidate !== character)
            : [...current, character].slice(0, 10)
        ))}
        onClose={() => setOpen(false)}
        onExited={() => undefined}
        onStart={() => {
          setSavedCount(selected.length);
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

async function setTextInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
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
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
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

  it("refreshes auto targets and supports a transient searchable custom selection", async () => {
    await act(async () => root!.render(createElement(IntroHarness)));
    await act(async () => button("Open Learn").click());

    expect(document.querySelector(".letters-lesson-character-list strong")?.textContent)
      .toBe(practiceCharacters[0]);
    await act(async () => button("Refresh characters").click());
    expect(document.querySelector(".letters-lesson-character-list strong")?.textContent)
      .toBe(practiceCharacters[5]);

    await act(async () => button("Custom").click());
    expect(button("Custom").getAttribute("aria-pressed")).toBe("true");
    const search = document.querySelector<HTMLInputElement>(
      '.letters-practice-custom-picker input[placeholder*="Search character"]',
    )!;
    await setTextInput(search, "U+3042");
    const customTile = document.querySelector<HTMLButtonElement>(".letters-grid-viewport.is-picker button")!;
    expect(customTile.textContent).toContain(practiceCharacters[0]);
    expect(customTile.getAttribute("aria-selected")).toBe("false");
    await act(async () => customTile.click());
    expect(document.querySelectorAll(".letters-lesson-character-list article")).toHaveLength(6);
    expect(document.body.textContent).toContain("26 exercises before retries");

    await act(async () => button("Start lesson").click());
    expect(document.querySelector("#saved-practice-count")?.textContent).toBe("6");
  });

  it("speaks hiragana vu through its supported Japanese pronunciation equivalent", async () => {
    await act(async () => root!.render(createElement(LettersLessonIntro, {
      open: true,
      language: "Japanese",
      scriptLabel: "Hiragana",
      characters: ["\u3094"],
      metadata: new Map([["\u3094", { reading: "vu" }]]),
      characterCount: 1,
      exerciseCount: 5,
      maxCharacterCount: 1,
      availableCharacters: ["\u3094"],
      progress: {},
      selectionMode: "auto",
      customQuery: "",
      canRefresh: false,
      onCharacterCountChange: vi.fn(),
      onCustomQueryChange: vi.fn(),
      onRefresh: vi.fn(),
      onSelectionModeChange: vi.fn(),
      onToggleCustomCharacter: vi.fn(),
      onClose: vi.fn(),
      onExited: vi.fn(),
      onStart: vi.fn(),
    })));

    const speaker = document.querySelector<HTMLButtonElement>(".letters-lesson-character-list button")!;
    await act(async () => speaker.click());
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ text: "\u30f4", lang: "ja-JP", rate: 0.82 });
    expect(document.querySelector(".letters-lesson-character-list strong")?.textContent).toBe("\u3094");
  });

  it("shows a Unicode label without a speaker when pronunciation metadata is missing", async () => {
    await act(async () => root!.render(createElement(LettersLessonIntro, {
      open: true,
      language: "Japanese",
      scriptLabel: "Kanji",
      characters: ["\u6c34"],
      metadata: new Map(),
      characterCount: 1,
      exerciseCount: 4,
      maxCharacterCount: 1,
      availableCharacters: ["\u6c34"],
      progress: {},
      selectionMode: "auto",
      customQuery: "",
      canRefresh: false,
      onCharacterCountChange: vi.fn(),
      onCustomQueryChange: vi.fn(),
      onRefresh: vi.fn(),
      onSelectionModeChange: vi.fn(),
      onToggleCustomCharacter: vi.fn(),
      onClose: vi.fn(),
      onExited: vi.fn(),
      onStart: vi.fn(),
    })));

    const row = document.querySelector(".letters-lesson-character-list article")!;
    expect(row.querySelector("button")).toBeNull();
    expect(row.textContent).toContain("U+6C34");
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
