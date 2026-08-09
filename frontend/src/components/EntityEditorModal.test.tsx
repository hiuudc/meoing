// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Collection } from "../types";
import { EntityEditorModal } from "./EntityEditorModal";

let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
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

function renderCollectionEditor(value?: Collection) {
  document.body.innerHTML = '<div id="mount"></div>';
  root = createRoot(document.querySelector("#mount")!);
  const onSubmit = vi.fn();
  const onAccentPreview = vi.fn();

  return act(async () => {
    root!.render(
      <EntityEditorModal
        editor={{ type: "collection", value }}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onAccentPreview={onAccentPreview}
        targetLanguage="English"
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return { onAccentPreview, onSubmit };
  });
}

describe("EntityEditorModal collection languages", () => {
  it("requires an explicit language pair for a new collection", async () => {
    await renderCollectionEditor();

    const learningLanguage = document.querySelector<HTMLSelectElement>('select[aria-label="Language learning"]')
      ?? Array.from(document.querySelectorAll<HTMLSelectElement>("select"))[0];
    const speakingLanguage = document.querySelector<HTMLSelectElement>('select[aria-label="Language speaking"]')
      ?? Array.from(document.querySelectorAll<HTMLSelectElement>("select"))[1];

    expect(learningLanguage.value).toBe("");
    expect(learningLanguage.selectedOptions[0]?.textContent).toBe("Select learning language");
    expect(speakingLanguage.value).toBe("");
    expect(speakingLanguage.selectedOptions[0]?.textContent).toBe("Select speaking language");
  });

  it("keeps the saved language pair when editing a collection", async () => {
    await renderCollectionEditor({
      id: "collection-1",
      name: "Japanese notes",
      icon: "J",
      accent: "#8B7CF6",
      learningProfile: {
        targetLanguage: "Japanese",
        sourceLanguage: "Vietnamese",
      },
    } as Collection);

    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>("select"));
    expect(selects[0]?.value).toBe("Japanese");
    expect(selects[1]?.value).toBe("Vietnamese");
  });
});
