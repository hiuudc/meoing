// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LetterSettings } from "../learning/letters";
import { LetterSettingsModal } from "./LetterSettingsModal";

const INITIAL_SETTINGS: LetterSettings = {
  practiceQuestionCount: 5,
  requireStrokeOrder: true,
  showStrokeGuide: true,
  strokeTolerance: 1,
};

let root: Root | null = null;

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => (
      candidate.textContent?.includes(label) || candidate.getAttribute("aria-label") === label
    ));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function Harness({ onPersist }: { onPersist: (settings: LetterSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  return (
    <>
      <button id="letter-settings-opener" type="button" onClick={() => setOpen(true)}>Open settings</button>
      <output id="saved-letter-settings">{JSON.stringify(settings)}</output>
      <LetterSettingsModal
        open={open}
        collectionName="Japanese Foundations"
        language="Japanese"
        value={settings}
        onClose={() => setOpen(false)}
        onApply={(next) => {
          setSettings(next);
          onPersist(next);
          setOpen(false);
        }}
      />
    </>
  );
}

async function renderHarness(onPersist = vi.fn()) {
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(Harness, { onPersist }));
  });
  return onPersist;
}

async function openModal() {
  const opener = button("Open settings");
  opener.focus();
  await act(async () => opener.click());
  await vi.waitFor(() => expect(document.querySelector(".letter-settings-modal")).not.toBeNull());
}

async function setNumberInput(input: HTMLInputElement, value: number) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function finishExit() {
  const panel = document.querySelector<HTMLElement>(".letter-settings-modal");
  if (!panel) return;
  await act(async () => {
    panel.dispatchEvent(new Event("animationend", { bubbles: true }));
  });
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

describe("LetterSettingsModal", () => {
  it("shows all four settings and only persists the draft after Apply", async () => {
    const onPersist = await renderHarness();
    await openModal();

    expect(document.querySelector<HTMLInputElement>("#letter-settings-practice-length")?.value).toBe("5");
    expect(document.body.textContent).toContain("Require stroke order");
    expect(document.body.textContent).toContain("Stroke tolerance");
    expect(document.body.textContent).toContain("Show drag direction");

    await setNumberInput(
      document.querySelector<HTMLInputElement>("#letter-settings-practice-length")!,
      8,
    );
    await act(async () => button("Forgiving").click());
    expect(onPersist).not.toHaveBeenCalled();

    await act(async () => button("Apply settings").click());

    expect(onPersist).toHaveBeenCalledWith({
      practiceQuestionCount: 8,
      requireStrokeOrder: true,
      showStrokeGuide: true,
      strokeTolerance: 2,
    });
    expect(document.querySelector("#saved-letter-settings")?.textContent).toContain(
      '"practiceQuestionCount":8',
    );
  });

  it("dims dependent controls without deleting their draft values", async () => {
    const onPersist = await renderHarness();
    await openModal();
    await act(async () => button("Forgiving").click());

    const requireStrokeOrder = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((input) => input.closest("label")?.textContent?.includes("Require stroke order"));
    if (!requireStrokeOrder) throw new Error("Require stroke order checkbox not found.");
    await act(async () => requireStrokeOrder.click());

    const dependent = document.querySelector<HTMLFieldSetElement>(".letter-settings-dependent");
    expect(dependent?.disabled).toBe(true);
    expect(dependent?.classList.contains("is-disabled")).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#letter-settings-stroke-tolerance")?.matches(":disabled"))
      .toBe(true);
    expect(document.body.textContent).toContain("unavailable while stroke order is off");

    await act(async () => requireStrokeOrder.click());
    expect(document.querySelector<HTMLInputElement>("#letter-settings-stroke-tolerance")?.getAttribute("aria-valuenow"))
      .toBe("2");
    await act(async () => button("Apply settings").click());
    expect(onPersist).toHaveBeenCalledWith(expect.objectContaining({ strokeTolerance: 2 }));
  });

  it("discards drafts on Cancel, Escape, and overlay dismissal and restores focus", async () => {
    const onPersist = await renderHarness();

    for (const dismiss of ["cancel", "escape", "overlay"] as const) {
      await openModal();
      await setNumberInput(
        document.querySelector<HTMLInputElement>("#letter-settings-practice-length")!,
        9,
      );

      if (dismiss === "cancel") {
        await act(async () => button("Cancel").click());
      } else if (dismiss === "escape") {
        await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      } else {
        const backdrop = document.querySelector<HTMLElement>(".letter-settings-backdrop");
        if (!backdrop) throw new Error("Letter settings backdrop not found.");
        await act(async () => backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      }
      await finishExit();

      expect(onPersist).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.querySelector("#letter-settings-opener"));
      expect(document.querySelector("#saved-letter-settings")?.textContent).toContain(
        '"practiceQuestionCount":5',
      );
    }

    await openModal();
    expect(document.querySelector<HTMLInputElement>("#letter-settings-practice-length")?.value).toBe("5");
  });
});
