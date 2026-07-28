// @vitest-environment jsdom
// Keep bridge-gate coverage in the main web-test suite.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalPreviewLesson } from "../learning/demoLesson";
import { normalizeLearningProfile } from "../learning/profile";
import {
  ExtensionBridgeError,
  extensionBridge,
  type ExtensionCompatibility,
} from "../integration/extensionBridge";
import { LEARNING_STORAGE_KEY } from "../integration/learningStorage";
import {
  PENDING_LEARNING_OPERATIONS_KEY,
  createPendingLearningOperationStore,
  putPendingLearningOperation,
  savePendingLearningOperations,
} from "../integration/pendingLearningOperations";
import {
  MEOI_CHAT_RESULT_TYPE,
  MEOI_EXTENSION_MIN_VERSION,
  MEOI_EXTENSION_PROTOCOL_VERSION,
  type ChatOperationResult,
  type ChatOperationState,
} from "../integration/protocol";
import { createSeedState } from "../store";
import { LearningWorkspace, publicLearningError } from "./LearningWorkspace";

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

async function renderWithCompatibility(
  compatibility: ExtensionCompatibility,
  state = createSeedState(),
) {
  vi.spyOn(extensionBridge, "detectCompatibility").mockResolvedValue(compatibility);
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
  return state;
}

function pendingResult(state: ReturnType<typeof createSeedState>, operationId = "pending-operation") {
  const collection = state.collections[state.activeCollectionId];
  const unit = state.units[state.activeUnitId];
  const lesson = createLocalPreviewLesson(
    unit.id,
    unit.name,
    normalizeLearningProfile(collection.learningProfile),
  );
  const result: ChatOperationResult = {
    type: MEOI_CHAT_RESULT_TYPE,
    protocolVersion: MEOI_EXTENSION_PROTOCOL_VERSION,
    operationId,
    kind: "create_lesson",
    outcome: "completed",
    result: { lesson },
  };
  const operation = {
    operationId,
    unitId: unit.id,
    kind: "create_lesson" as const,
    createdAt: new Date().toISOString(),
  };
  return { operation, result };
}

function completedState(
  operation: ReturnType<typeof pendingResult>["operation"],
  result: ChatOperationResult,
): ChatOperationState {
  return {
    operationId: operation.operationId,
    unitId: operation.unitId,
    phase: "completed",
    repairAttempt: 0,
    updatedAt: new Date().toISOString(),
    result,
  };
}

function storePending(operation: ReturnType<typeof pendingResult>["operation"]) {
  const store = putPendingLearningOperation(createPendingLearningOperationStore(), operation);
  expect(savePendingLearningOperations(store, window.localStorage)).toBe(true);
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
  it("turns a missing extension receiver into an actionable retry message", () => {
    expect(publicLearningError(new Error("Could not establish connection. Receiving end does not exist.")))
      .toContain("Reload this page");
    expect(publicLearningError(new ExtensionBridgeError("EXTENSION_NOT_READY", "Bridge missing.")))
      .toContain("current answer is still here");
  });

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

  it("locks Learn when protocol v8 comes from extension 8.0.3", async () => {
    await renderWithCompatibility({
      state: "outdated",
      version: 8,
      integration: {
        installed: true,
        extensionVersion: "8.0.3",
        pausedForQuota: false,
        queueLength: 0,
      },
    });
    expect(document.querySelector(".learning-bridge-gate")?.textContent).toContain("Version 8.0.3 was detected");
    expect(document.body.textContent).toContain(`Update Meoi Bridge to ${MEOI_EXTENSION_MIN_VERSION}`);
    expect(document.body.textContent).not.toContain("Player demo");
  });

  it("mounts the normal Learn workspace only for bridge v8", async () => {
    await renderWithCompatibility({
      state: "ready",
      version: 8,
      integration: { installed: true, extensionVersion: MEOI_EXTENSION_MIN_VERSION, pausedForQuota: false, queueLength: 0 },
    });
    expect(document.querySelector(".learning-bridge-gate")).toBeNull();
    expect(document.body.textContent).toContain("Player demo");
    expect(document.body.textContent).toContain("Learning profile");
    expect(document.body.textContent).toContain("Open Voice");
  });
});

describe("LearningWorkspace pending lesson recovery", () => {
  const ready: ExtensionCompatibility = {
    state: "ready",
    version: 8,
    integration: { installed: true, extensionVersion: MEOI_EXTENSION_MIN_VERSION, pausedForQuota: false, queueLength: 0 },
  };

  it("recovers a completed lesson after remount and saves before ACK", async () => {
    const state = createSeedState();
    const { operation, result } = pendingResult(state);
    storePending(operation);
    const events: string[] = [];
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => {
      if (key === LEARNING_STORAGE_KEY) events.push("save");
      originalSetItem(key, value);
    });
    vi.spyOn(extensionBridge, "getOperationState").mockResolvedValue(completedState(operation, result));
    vi.spyOn(extensionBridge, "acknowledgeOperation").mockImplementation(async () => {
      events.push("ack");
      return true;
    });

    await renderWithCompatibility(ready, state);
    await act(async () => {
      await vi.waitFor(() => expect(window.localStorage.getItem(LEARNING_STORAGE_KEY)).not.toBeNull());
    });

    expect(events.indexOf("save")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("ack")).toBeGreaterThan(events.indexOf("save"));
    expect(window.localStorage.getItem(PENDING_LEARNING_OPERATIONS_KEY)).toContain('"operationsByUnit":{}');
    expect(document.body.textContent).toContain("Lesson received from ChatGPT and saved locally");
  });

  it("records the operation ID before dispatching a new lesson request", async () => {
    const state = createSeedState();
    const dispatch = vi.spyOn(extensionBridge, "dispatchAndWait").mockImplementation(async (payload) => {
      expect(window.localStorage.getItem(PENDING_LEARNING_OPERATIONS_KEY)).toContain(payload.operationId);
      const generated = pendingResult(state, payload.operationId);
      return completedState(generated.operation, generated.result);
    });
    vi.spyOn(extensionBridge, "acknowledgeOperation").mockResolvedValue(true);

    await renderWithCompatibility(ready, state);
    const create = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Create lesson"));
    expect(create).toBeTruthy();
    await act(async () => {
      create!.click();
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(window.localStorage.getItem(LEARNING_STORAGE_KEY)).not.toBeNull());
    });
  });

  it("reattaches to an active operation before consuming its completed result", async () => {
    const state = createSeedState();
    const { operation, result } = pendingResult(state);
    storePending(operation);
    vi.spyOn(extensionBridge, "getOperationState").mockResolvedValue({
      operationId: operation.operationId,
      unitId: operation.unitId,
      phase: "awaiting_response",
      repairAttempt: 0,
      updatedAt: new Date().toISOString(),
    });
    const waitSpy = vi.spyOn(extensionBridge, "waitForOperation")
      .mockResolvedValue(completedState(operation, result));
    vi.spyOn(extensionBridge, "acknowledgeOperation").mockResolvedValue(true);

    await renderWithCompatibility(ready, state);
    await act(async () => {
      await vi.waitFor(() => expect(waitSpy).toHaveBeenCalledWith(
        operation.operationId,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ));
      await vi.waitFor(() => expect(window.localStorage.getItem(LEARNING_STORAGE_KEY)).not.toBeNull());
    });
  });

  it("keeps the extension result when local save fails and retries it later", async () => {
    const state = createSeedState();
    const { operation, result } = pendingResult(state);
    storePending(operation);
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    let failLearningSave = true;
    vi.spyOn(window.localStorage, "setItem").mockImplementation((key, value) => {
      if (key === LEARNING_STORAGE_KEY && failLearningSave) throw new DOMException("Quota exceeded", "QuotaExceededError");
      originalSetItem(key, value);
    });
    vi.spyOn(extensionBridge, "getOperationState").mockResolvedValue(completedState(operation, result));
    const acknowledge = vi.spyOn(extensionBridge, "acknowledgeOperation").mockResolvedValue(true);

    await renderWithCompatibility(ready, state);
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain("Retry local save"));
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PENDING_LEARNING_OPERATIONS_KEY)).toContain(operation.operationId);

    failLearningSave = false;
    const retry = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Retry local save"));
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
      await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledWith(operation.operationId));
    });
    expect(window.localStorage.getItem(LEARNING_STORAGE_KEY)).not.toBeNull();
  });

  it("clears stale pending metadata when an extension reload loses the operation", async () => {
    const state = createSeedState();
    const { operation } = pendingResult(state);
    storePending(operation);
    vi.spyOn(extensionBridge, "getOperationState").mockRejectedValue(
      new ExtensionBridgeError("OPERATION_STATE_NOT_FOUND", "Operation not found."),
    );

    await renderWithCompatibility(ready, state);
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain("no longer has this lesson operation"));
    });
    expect(window.localStorage.getItem(PENDING_LEARNING_OPERATIONS_KEY)).toContain('"operationsByUnit":{}');
    expect(document.body.textContent).toContain("Create lesson again");
  });

  it("retains a failed validator result until the learner creates again", async () => {
    const state = createSeedState();
    const { operation } = pendingResult(state);
    storePending(operation);
    vi.spyOn(extensionBridge, "getOperationState").mockResolvedValue({
      operationId: operation.operationId,
      unitId: operation.unitId,
      phase: "failed",
      repairAttempt: 3,
      updatedAt: new Date().toISOString(),
      error: {
        code: "INVALID_CHATGPT_RESPONSE",
        message: "questionAlternates must contain one alternate for every primary question.",
      },
    });
    const acknowledge = vi.spyOn(extensionBridge, "acknowledgeOperation").mockResolvedValue(true);

    await renderWithCompatibility(ready, state);
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain("questionAlternates must contain"));
    });
    expect(document.body.textContent).toContain("Create lesson again");
    expect(window.localStorage.getItem(PENDING_LEARNING_OPERATIONS_KEY)).toContain(operation.operationId);
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
