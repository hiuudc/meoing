// @vitest-environment jsdom
// Keep bridge-gate coverage in the main web-test suite.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionBridge, type ExtensionCompatibility } from "../integration/extensionBridge";
import { createSeedState } from "../store";
import { LearningWorkspace } from "./LearningWorkspace";

let root: Root | null = null;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

async function renderWithCompatibility(compatibility: ExtensionCompatibility) {
  vi.spyOn(extensionBridge, "detectCompatibility").mockResolvedValue(compatibility);
  const state = createSeedState();
  const collection = state.collections[state.activeCollectionId];
  const unit = state.units[state.activeUnitId];
  document.body.innerHTML = '<div class="app-shell"><div id="mount"></div></div>';
  root = createRoot(document.querySelector("#mount")!);
  await act(async () => {
    root!.render(createElement(LearningWorkspace, {
      collection,
      unit,
      documents: state.documentOrder
        .map((id) => state.documents[id])
        .filter((document) => document.unitId === unit.id),
      studyItems: state.studyItemOrder
        .map((id) => state.studyItems[id])
        .filter((item) => item.unitId === unit.id),
      mode: "learn",
      onModeChange: vi.fn(),
      onOpenMobileNavigation: vi.fn(),
      onUpdateProfile: vi.fn(),
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("LearningWorkspace bridge v8 gate", () => {
  it("locks Learn completely when no extension responds", async () => {
    await renderWithCompatibility({ state: "unavailable" });
    expect(document.querySelector(".learning-bridge-gate")?.textContent).toContain("Meoi Bridge v8 required");
    expect(document.body.textContent).not.toContain("Player demo");
    expect(document.body.textContent).not.toContain("Learning profile");
    expect(document.body.textContent).not.toContain("Open Voice");
  });

  it("shows the detected outdated bridge version without mounting Learn features", async () => {
    await renderWithCompatibility({
      state: "outdated",
      version: 7,
      integration: { installed: true, pausedForQuota: false, queueLength: 0 },
    });
    expect(document.querySelector(".learning-bridge-gate")?.textContent).toContain("protocol v7 was detected");
    expect(document.body.textContent).not.toContain("Player demo");
    expect(document.body.textContent).not.toContain("Learning profile");
  });

  it("mounts the normal Learn workspace only for bridge v8", async () => {
    await renderWithCompatibility({
      state: "ready",
      version: 8,
      integration: { installed: true, pausedForQuota: false, queueLength: 0 },
    });
    expect(document.querySelector(".learning-bridge-gate")).toBeNull();
    expect(document.body.textContent).toContain("Player demo");
    expect(document.body.textContent).toContain("Learning profile");
    expect(document.body.textContent).toContain("Open Voice");
  });
});
