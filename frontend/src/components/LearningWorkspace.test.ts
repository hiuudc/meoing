// @vitest-environment jsdom
// Keep bridge-gate coverage in the main web-test suite.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { buildProgressBatch } from "../api/progressOutbox";
import { createLocalPreviewLesson } from "../learning/demoLesson";
import { normalizeLearningProfile } from "../learning/profile";
import type { AttemptRecord, LessonProgressSnapshot } from "../learning/types";
import {
  ExtensionBridgeError,
  extensionBridge,
  type ExtensionCompatibility,
} from "../integration/extensionBridge";
import {
  MEOI_CHAT_RESULT_TYPE,
  MEOI_EXTENSION_MIN_VERSION,
  MEOI_EXTENSION_PROTOCOL_VERSION,
  type ChatOperationResult,
  type ChatOperationState,
} from "../integration/protocol";
import { createSeedState } from "../store";
import {
  canDeleteStoredLesson,
  LearningWorkspace,
  persistProgressBeforeEvaluationAck,
  progressSnapshotFromWire,
  publicLearningError,
} from "./LearningWorkspace";

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
  cloud?: { api: ApiClient; userId: string },
  recoveredOperation: ChatOperationState | null = null,
  permissions: {
    canCreateLessons?: boolean;
    canDeleteContent?: boolean;
    canManageCollectionProfile?: boolean;
  } = {},
) {
  vi.spyOn(extensionBridge, "detectCompatibility").mockResolvedValue(compatibility);
  vi.spyOn(extensionBridge, "getLatestUnitOperation").mockResolvedValue(recoveredOperation);
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
      api: cloud?.api,
      userId: cloud?.userId,
      ...permissions,
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

  it("locks Learn when protocol v8 comes from extension 8.0.4", async () => {
    await renderWithCompatibility({
      state: "outdated",
      version: 8,
      integration: {
        installed: true,
        extensionVersion: "8.0.4",
        pausedForQuota: false,
        queueLength: 0,
      },
    });
    expect(document.querySelector(".learning-bridge-gate")?.textContent).toContain("Version 8.0.4 was detected");
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

describe("LearningWorkspace cloud lesson persistence", () => {
  const ready: ExtensionCompatibility = {
    state: "ready",
    version: 8,
    integration: { installed: true, extensionVersion: MEOI_EXTENSION_MIN_VERSION, pausedForQuota: false, queueLength: 0 },
  };

  function createCloudApi(state: ReturnType<typeof createSeedState>) {
    const unit = state.units[state.activeUnitId];
    const events: string[] = [];
    const get = vi.fn(async () => ({ data: { items: [], nextCursor: null } }));
    const post = vi.fn(async (path: string, body?: unknown) => {
      if (path === "/v1/lessons") {
        events.push("save");
        const payload = (body as { payload: unknown }).payload;
        return {
          data: {
            id: "server-lesson",
            unitId: unit.id,
            ownerId: "user-1",
            status: "draft",
            revision: 1,
            payload,
            createdAt: new Date().toISOString(),
          },
        };
      }
      if (path === "/v1/lessons/server-lesson/progress") {
        events.push("session");
        return { data: { id: "progress-session" } };
      }
      throw new Error(`Unexpected POST ${path}`);
    });
    const api = { get, post, delete: vi.fn() } as unknown as ApiClient;
    return { api, events, get, post };
  }

  it("keeps the cloud cache request alive when Learn unmounts during a workspace switch", async () => {
    const state = createSeedState();
    let lessonSignal: AbortSignal | undefined;
    let resolveLessons: ((value: { data: { items: []; nextCursor: null } }) => void) | undefined;
    const get = vi.fn((path: string, signal?: AbortSignal) => {
      if (path.startsWith("/v1/lessons?")) {
        lessonSignal = signal;
        return new Promise<{ data: { items: []; nextCursor: null } }>((resolve) => {
          resolveLessons = resolve;
        });
      }
      return Promise.resolve({ data: { items: [], nextCursor: null } });
    });
    const api = { get, post: vi.fn(), delete: vi.fn() } as unknown as ApiClient;

    await renderWithCompatibility(ready, state, { api, userId: "user-1" });
    await vi.waitFor(() => expect(lessonSignal).toBeDefined());

    await act(async () => root?.unmount());
    root = null;

    expect(lessonSignal?.aborted).toBe(false);
    resolveLessons?.({ data: { items: [], nextCursor: null } });
  });

  it("saves a generated lesson through the Worker before acknowledging the extension", async () => {
    const state = createSeedState();
    const cloud = createCloudApi(state);
    const dispatch = vi.spyOn(extensionBridge, "dispatchAndWait").mockImplementation(async (payload) => {
      const generated = pendingResult(state, payload.operationId);
      return completedState(generated.operation, generated.result);
    });
    vi.spyOn(extensionBridge, "acknowledgeOperation").mockImplementation(async () => {
      cloud.events.push("ack");
      return true;
    });

    await renderWithCompatibility(ready, state, { api: cloud.api, userId: "user-1" });
    await vi.waitFor(() => expect(cloud.get).toHaveBeenCalled());
    const create = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Create lesson"));
    expect(create).toBeTruthy();
    expect(create!.disabled).toBe(false);
    await act(async () => {
      create!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(cloud.events).toEqual(["save", "session", "ack"]));
    });

    expect(cloud.events).toEqual(["save", "session", "ack"]);
    expect(window.localStorage.length).toBe(0);
  });

  it("loads existing validated lessons from the Worker without localStorage", async () => {
    const state = createSeedState();
    const lesson = pendingResult(state).result.result!.lesson!;
    const api = {
      get: vi.fn(async () => ({
        data: {
          items: [{
            id: "server-lesson",
            unitId: state.activeUnitId,
            ownerId: "user-1",
            status: "draft",
            revision: 1,
            payload: lesson,
            createdAt: new Date().toISOString(),
          }],
          nextCursor: null,
        },
      })),
      post: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiClient;
    await renderWithCompatibility(ready, state, { api, userId: "user-1" });
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain("Synced lesson history"));
    });
    expect(document.body.textContent).toContain("Synced");
    expect(document.querySelector('[aria-label^="Delete saved lesson"]')).not.toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it("loads raw attempts from the authorized progress detail route", async () => {
    const state = createSeedState();
    const lesson = pendingResult(state).result.result!.lesson!;
    const progressId = "progress-detail-1";
    const get = vi.fn(async (path: string) => {
      if (path.startsWith("/v1/lessons?")) {
        return {
          data: {
            items: [{
              id: "server-lesson",
              unitId: state.activeUnitId,
              ownerId: "user-1",
              status: "draft",
              revision: 1,
              payload: lesson,
              createdAt: "2026-07-30T09:00:00.000Z",
            }],
            nextCursor: null,
          },
        };
      }
      if (path.startsWith("/v1/progress?")) {
        return {
          data: {
            items: [{
              id: progressId,
              lessonId: "server-lesson",
              updatedAt: "2026-07-30T10:00:00.000Z",
            }],
            nextCursor: null,
          },
        };
      }
      if (path === `/v1/progress/${progressId}`) {
        return {
          data: {
            id: progressId,
            lessonId: "server-lesson",
            updatedAt: "2026-07-30T10:00:00.000Z",
            attempts: [{
              questionId: lesson.questions[0].id,
              attemptNumber: 1,
              status: "correct",
            }],
          },
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const api = {
      get,
      post: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiClient;

    await renderWithCompatibility(ready, state, { api, userId: "user-1" });

    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(
      `/v1/progress/${progressId}`,
      expect.any(AbortSignal),
    ));
    const expectedMastery = Math.round((1 / lesson.questions.length) * 100);
    await vi.waitFor(() => expect(document.body.textContent).toContain(`${expectedMastery}%`));
  });

  it("rebuilds the latest lesson mastery snapshot from cloud attempts", () => {
    const state = createSeedState();
    const lesson = pendingResult(state).result.result!.lesson!;
    const first = lesson.questions[0].id;
    const second = lesson.questions[1].id;

    expect(progressSnapshotFromWire(lesson, {
      id: "progress-1",
      lessonId: lesson.id,
      updatedAt: "2026-07-30T10:00:00.000Z",
      attempts: [
        { questionId: first, attemptNumber: 1, status: "correct" },
        { questionId: second, attemptNumber: 1, status: "incorrect" },
        { questionId: second, attemptNumber: 2, status: "correct" },
        { questionId: "not-in-lesson", attemptNumber: 1, status: "correct" },
      ],
    })).toEqual(expect.objectContaining({
      lessonId: lesson.id,
      completedQuestionIds: [first, second],
      attemptsByQuestion: { [first]: 1, [second]: 2 },
      firstTryCorrect: 1,
      masteryPercent: Math.round((2 / lesson.questions.length) * 100),
    }));
  });

  it("acknowledges an AI evaluation only after its progress batch is durable", async () => {
    const events: string[] = [];
    const attempt: AttemptRecord = {
      attemptId: "11111111-1111-4111-8111-111111111111",
      questionId: "question-1",
      attemptNumber: 1,
      answer: "cat",
      evaluationSource: "client_extension",
      status: "correct",
      outcome: "correct",
      score: 1,
      firstTry: true,
      answeredAt: "2026-07-30T10:00:00.000Z",
    };
    const snapshot: LessonProgressSnapshot = {
      lessonId: "22222222-2222-4222-8222-222222222222",
      completedQuestionIds: ["question-1"],
      attemptsByQuestion: { "question-1": 1 },
      firstTryCorrect: 1,
      totalQuestions: 1,
      masteryPercent: 100,
      updatedAt: "2026-07-30T10:00:00.000Z",
    };
    const pendingAcks = new Map([["question-1", ["extension-operation"]]]);

    const failures = await persistProgressBeforeEvaluationAck(
      "user-1",
      "progress-1",
      buildProgressBatch([attempt], snapshot, "33333333-3333-4333-8333-333333333333"),
      [attempt],
      pendingAcks,
      {
        enqueue: vi.fn(async () => { events.push("enqueue"); }),
        acknowledge: vi.fn(async () => {
          events.push("ack");
          return true;
        }),
      },
    );

    expect(events).toEqual(["enqueue", "ack"]);
    expect(failures).toBe(0);
    expect(pendingAcks.size).toBe(0);
  });

  it("retains the extension result when the progress outbox write fails", async () => {
    const attempt: AttemptRecord = {
      attemptId: "11111111-1111-4111-8111-111111111111",
      questionId: "question-1",
      attemptNumber: 1,
      answer: "cat",
      evaluationSource: "client_extension",
      status: "correct",
      outcome: "correct",
      score: 1,
      firstTry: true,
      answeredAt: "2026-07-30T10:00:00.000Z",
    };
    const snapshot: LessonProgressSnapshot = {
      lessonId: "22222222-2222-4222-8222-222222222222",
      completedQuestionIds: ["question-1"],
      attemptsByQuestion: { "question-1": 1 },
      firstTryCorrect: 1,
      totalQuestions: 1,
      masteryPercent: 100,
      updatedAt: "2026-07-30T10:00:00.000Z",
    };
    const pendingAcks = new Map([["question-1", ["extension-operation"]]]);
    const acknowledge = vi.fn(async () => true);

    await expect(persistProgressBeforeEvaluationAck(
      "user-1",
      "progress-1",
      buildProgressBatch([attempt], snapshot, "33333333-3333-4333-8333-333333333333"),
      [attempt],
      pendingAcks,
      {
        enqueue: vi.fn(async () => { throw new Error("IndexedDB unavailable"); }),
        acknowledge,
      },
    )).rejects.toThrow("IndexedDB unavailable");

    expect(acknowledge).not.toHaveBeenCalled();
    expect(pendingAcks.get("question-1")).toEqual(["extension-operation"]);
  });

  it("recovers an extension-owned lesson after a reload mid-operation", async () => {
    const state = createSeedState();
    const cloud = createCloudApi(state);
    const generated = pendingResult(state, "operation-from-before-reload");
    const completed = completedState(generated.operation, generated.result);
    const recovered: ChatOperationState = {
      ...completed,
      phase: "awaiting_response",
      result: undefined,
    };
    const getById = vi.spyOn(extensionBridge, "getOperationState");
    const waitForOperation = vi.spyOn(extensionBridge, "waitForOperation").mockResolvedValue(completed);
    vi.spyOn(extensionBridge, "acknowledgeOperation").mockImplementation(async () => {
      cloud.events.push("ack");
      return true;
    });

    await renderWithCompatibility(ready, state, { api: cloud.api, userId: "user-1" }, recovered);
    await act(async () => {
      await vi.waitFor(() => expect(cloud.events).toEqual(["save", "session", "ack"]));
    });

    expect(extensionBridge.getLatestUnitOperation).toHaveBeenCalledWith(
      state.activeUnitId,
      "create_lesson",
    );
    expect(cloud.post).toHaveBeenCalledWith(
      "/v1/lessons",
      expect.any(Object),
      "operation-from-before-reload",
    );
    expect(waitForOperation).toHaveBeenCalledWith(
      "operation-from-before-reload",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getById).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Lesson received from ChatGPT and synced to Meoing.");
    expect(window.localStorage.length).toBe(0);
  });

  it("retains an extension result in memory when cloud saving fails", async () => {
    const state = createSeedState();
    const cloud = createCloudApi(state);
    cloud.post.mockImplementationOnce(async () => {
      throw new Error("database unavailable");
    });
    const dispatch = vi.spyOn(extensionBridge, "dispatchAndWait").mockImplementation(async (payload) => {
      const generated = pendingResult(state, payload.operationId);
      return completedState(generated.operation, generated.result);
    });
    const acknowledge = vi.spyOn(extensionBridge, "acknowledgeOperation").mockResolvedValue(true);

    await renderWithCompatibility(ready, state, { api: cloud.api, userId: "user-1" });
    await vi.waitFor(() => expect(cloud.get).toHaveBeenCalled());
    const create = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Create lesson"));
    await act(async () => {
      create!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(cloud.post).toHaveBeenCalledWith(
        "/v1/lessons",
        expect.any(Object),
        expect.any(String),
      ));
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps lesson creation read-only when effective permissions omit create_lessons", async () => {
    await renderWithCompatibility(ready, createSeedState(), undefined, null, {
      canCreateLessons: false,
      canDeleteContent: false,
      canManageCollectionProfile: false,
    });

    expect(document.body.textContent).toContain("Lesson creation is read-only");
    expect(Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent?.includes("Create lesson"),
    )).toBe(false);
    expect(document.querySelector(".profile-editor")).toBeNull();
  });

  it("matches the backend lesson-delete rule for own drafts and delete_content", () => {
    const ownDraft = { ownerId: "user-1", status: "draft" as const };
    const ownPublished = { ownerId: "user-1", status: "published" as const };
    const otherDraft = { ownerId: "user-2", status: "draft" as const };

    expect(canDeleteStoredLesson(ownDraft, "user-1", false)).toBe(true);
    expect(canDeleteStoredLesson(ownPublished, "user-1", false)).toBe(false);
    expect(canDeleteStoredLesson(otherDraft, "user-1", false)).toBe(false);
    expect(canDeleteStoredLesson(ownPublished, "user-1", true)).toBe(true);
    expect(canDeleteStoredLesson(otherDraft, "user-1", true)).toBe(true);
  });
});
