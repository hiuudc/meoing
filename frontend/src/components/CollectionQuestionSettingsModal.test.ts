// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LEARNING_PROFILE } from "../learning/profile";
import { LESSON_QUESTION_FORMAT_DEFINITIONS } from "../learning/questionRegistry";
import type { Collection } from "../types";
import { CollectionQuestionSettingsPanel } from "./CollectionQuestionSettingsModal";

const enabledFormatIds = [
  "singleChoice",
  "multipleChoice",
  "trueFalse",
  "fillBlank",
  "translation",
] as const;

const collection: Collection = {
  id: "collection-test",
  name: "Test Collection",
  icon: "T",
  accent: "#655BF5",
  questionSettings: {
    enabledFormats: [...enabledFormatIds],
    characterTracing: { requireStrokeOrder: true },
  },
};

let root: Root | null = null;

function formatCard(format: string): HTMLElement {
  const card = document.querySelector<HTMLElement>(`[data-question-format="${format}"]`);
  if (!card) throw new Error(`Format card not found: ${format}`);
  return card;
}

function formatGroup(label: string): HTMLElement {
  const heading = Array.from(document.querySelectorAll<HTMLHeadingElement>(".question-format-group-heading h4"))
    .find((candidate) => candidate.textContent === label);
  const group = heading?.closest<HTMLElement>(".question-format-group");
  if (!group) throw new Error(`Format group not found: ${label}`);
  return group;
}

function groupCount(label: string): number {
  return Number(formatGroup(label).querySelector(".question-format-group-heading span")?.textContent);
}

async function renderPanel(onSave = vi.fn()) {
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(CollectionQuestionSettingsPanel, {
      collection,
      profile: { ...DEFAULT_LEARNING_PROFILE, targetLanguage: "English", speakingEnabled: false },
      onSave,
    }));
  });
  return onSave;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
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

describe("collection question format settings", () => {
  it("shows enabled and disabled groups with every preview always visible", async () => {
    await renderPanel();

    expect(groupCount("Enabled formats")).toBe(enabledFormatIds.length);
    expect(groupCount("Disabled formats")).toBe(
      LESSON_QUESTION_FORMAT_DEFINITIONS.length - enabledFormatIds.length,
    );
    expect(document.querySelectorAll(".collection-question-preview")).toHaveLength(
      LESSON_QUESTION_FORMAT_DEFINITIONS.length,
    );
    expect(document.body.textContent).not.toContain("Preview");
    expect(document.body.textContent).not.toContain("Custom blueprints");
  });

  it("moves toggled cards between groups and restores focus to their checkbox", async () => {
    await renderPanel();
    const selectBlank = formatCard("selectBlank").querySelector<HTMLInputElement>('input[type="checkbox"]')!;

    await act(async () => selectBlank.click());

    const enabledCheckbox = formatCard("selectBlank").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(formatGroup("Enabled formats").contains(enabledCheckbox)).toBe(true);
    expect(enabledCheckbox.checked).toBe(true);
    expect(document.activeElement).toBe(enabledCheckbox);
    expect(groupCount("Enabled formats")).toBe(enabledFormatIds.length + 1);

    await act(async () => enabledCheckbox.click());

    const disabledCheckbox = formatCard("selectBlank").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(formatGroup("Disabled formats").contains(disabledCheckbox)).toBe(true);
    expect(disabledCheckbox.checked).toBe(false);
    expect(document.activeElement).toBe(disabledCheckbox);
    expect(groupCount("Enabled formats")).toBe(enabledFormatIds.length);
  });

  it("dims unavailable formats and disables both toggle and preview controls", async () => {
    await renderPanel();
    const card = formatCard("speakingRepeat");
    const checkbox = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const preview = card.querySelector<HTMLFieldSetElement>(".collection-question-preview")!;

    expect(formatGroup("Disabled formats").contains(card)).toBe(true);
    expect(card.classList.contains("is-disabled")).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(preview.disabled).toBe(true);
    expect(card.textContent).toContain("Collection speaking is disabled.");
  });

  it("saves only the collection's enabled built-in formats", async () => {
    const onSave = await renderPanel();
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("Save changes"));
    if (!save) throw new Error("Save button not found.");
    await act(async () => save.click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      enabledFormats: [...enabledFormatIds],
      characterTracing: { requireStrokeOrder: true },
    });
  });
});
