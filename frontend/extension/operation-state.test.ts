import { describe, expect, it } from "vitest";
import {
  OPERATION_DEADLINE_MS,
  acknowledgeTerminalOperation,
  appendQueuedOperation,
  enqueueDecision,
  expiredActiveOperationIds,
  failOperationsForTabState,
  hasLegacyTransientState,
  pruneTerminalStates,
  publicOperationState,
  removeQueuedOperation,
  recoverOpeningOperations,
  retryDecision,
  transitionOperation,
} from "./operation-state";
import type { PersistedOperationState, QueuedOperation } from "./shared";
import { LESSON_QUESTION_FORMATS } from "../src/learning/types";

function operation(operationId = "op-1", unitId = "unit-1"): QueuedOperation {
  return {
    unitId,
    operationId,
    kind: "coaching",
    prompt: `prompt ${operationId}`,
    expectation: {
      unitId,
      targetLanguage: "English",
      sourceLanguage: "Vietnamese",
      level: "elementary",
      questionCount: 10,
      speaking: true,
      allowedFormats: [...LESSON_QUESTION_FORMATS],
      requiredTemplates: [],
    },
    queuedAt: "2026-07-17T00:00:00.000Z",
  };
}

function state(phase: PersistedOperationState["phase"] = "queued", operationId = "op-1", unitId = "unit-1"): PersistedOperationState {
  return {
    operationId,
    unitId,
    phase,
    repairAttempt: 0,
    updatedAt: "2026-07-17T00:00:00.000Z",
    operation: operation(operationId, unitId),
  };
}

describe("session extension operation state", () => {
  it("deduplicates an operation and serializes each unit queue", () => {
    const first = appendQueuedOperation({}, "unit-1", "op-1");
    const duplicate = appendQueuedOperation(first, "unit-1", "op-1");
    const second = appendQueuedOperation(duplicate, "unit-1", "op-2");
    expect(duplicate).toBe(first);
    expect(second["unit-1"]).toEqual(["op-1", "op-2"]);
    expect(removeQueuedOperation(second, "unit-1", "op-1")["unit-1"][0]).toBe("op-2");
  });

  it("deduplicates identical IDs, rejects conflicts, and caps outstanding work", () => {
    const original = state("queued");
    expect(enqueueDecision({ "op-1": original }, operation())).toBe("existing");
    expect(enqueueDecision({ "op-1": original }, { ...operation(), prompt: "different" })).toBe("conflict");
    const full = Object.fromEntries(Array.from({ length: 4 }, (_, index) => {
      const operationId = `op-${index + 1}`;
      return [operationId, state("awaiting_response", operationId, `unit-${index + 1}`)];
    }));
    expect(enqueueDecision(full, operation("op-5", "unit-5"))).toBe("full");
    expect(enqueueDecision({ ...full, "op-1": state("completed") }, operation("op-5", "unit-5"))).toBe("enqueue");
  });

  it("keeps queues independent across units", () => {
    const queues = appendQueuedOperation(
      appendQueuedOperation(appendQueuedOperation({}, "unit-1", "op-1"), "unit-2", "op-2"),
      "unit-1",
      "op-3",
    );
    expect(queues).toEqual({ "unit-1": ["op-1", "op-3"], "unit-2": ["op-2"] });
  });

  it("requeues only failed work and returns completed or active work unchanged", () => {
    expect(retryDecision()).toBe("missing");
    expect(retryDecision(state("queued"))).toBe("existing");
    expect(retryDecision(state("awaiting_response"))).toBe("existing");
    expect(retryDecision(state("completed"))).toBe("completed");
    expect(retryDecision(state("failed"))).toBe("requeue");
  });

  it("recovers only the pre-send opening phase after a worker restart", () => {
    const opening = { ...state("opening_chat", "op-1"), tabId: 42, deadlineAt: Date.now() + 1_000 };
    const awaiting = { ...state("awaiting_response", "op-2"), tabId: 43, deadlineAt: Date.now() + 1_000 };
    const recovered = recoverOpeningOperations({ "op-1": opening, "op-2": awaiting }, { "unit-1": ["op-2"] }, "2026-07-17T00:02:00.000Z");
    expect(recovered.recoveredOperationIds).toEqual(["op-1"]);
    expect(recovered.states["op-1"]).toMatchObject({ phase: "queued", tabId: undefined, deadlineAt: undefined });
    expect(recovered.states["op-2"]).toBe(awaiting);
    expect(recovered.queues["unit-1"]).toEqual(["op-2", "op-1"]);
  });

  it("fails active work for a closed tab without touching other tabs", () => {
    const first = { ...state("awaiting_response", "op-1", "unit-1"), tabId: 42 };
    const second = { ...state("awaiting_response", "op-2", "unit-2"), tabId: 43 };
    const error = { code: "CHATGPT_TAB_CHANGED" as const, message: "tab closed" };
    const failed = failOperationsForTabState(
      { "op-1": first, "op-2": second },
      { "unit-1": ["op-1"], "unit-2": ["op-2"] },
      42,
      error,
    );
    expect(failed.states["op-1"]).toMatchObject({ phase: "failed", error });
    expect(failed.states["op-2"]).toBe(second);
    expect(failed.queues).toEqual({ "unit-2": ["op-2"] });
    expect(failed.affectedUnitIds).toEqual(["unit-1"]);
  });

  it("ACK removes only terminal results and legacy queues are detected without replay", () => {
    const completed = state("completed", "op-1");
    const waiting = state("awaiting_response", "op-2");
    const first = acknowledgeTerminalOperation(
      { "op-1": completed, "op-2": waiting },
      { "unit-1": ["op-1", "op-2"] },
      "op-2",
    );
    expect(first.acknowledged).toBe(false);
    const acknowledged = acknowledgeTerminalOperation(first.states, first.queues, "op-1");
    expect(acknowledged.acknowledged).toBe(true);
    expect(Object.keys(acknowledged.states)).toEqual(["op-2"]);
    expect(acknowledged.queues["unit-1"]).toEqual(["op-2"]);
    expect(hasLegacyTransientState({ "meoi.queues.v1": [] }, ["meoi.queues.v1"])).toBe(true);
    expect(hasLegacyTransientState({}, ["meoi.queues.v1"])).toBe(false);
  });

  it("keeps internal retry payload out of the public operation state", () => {
    const waiting = transitionOperation(state(), "awaiting_response", "2026-07-17T00:01:00.000Z", {
      tabId: 42,
      deadlineAt: Date.now() + OPERATION_DEADLINE_MS,
    });
    expect(publicOperationState(waiting)).toEqual({
      operationId: "op-1",
      unitId: "unit-1",
      phase: "awaiting_response",
      repairAttempt: 0,
      updatedAt: "2026-07-17T00:01:00.000Z",
      result: undefined,
      error: undefined,
    });
  });

  it("expires active work by deadline and prunes only stale terminal results", () => {
    const now = Date.parse("2026-07-18T00:00:01.000Z");
    const active = { ...state("awaiting_response"), deadlineAt: now - 1 };
    const completed = state("completed", "op-2");
    const queued = state("queued", "op-3");
    expect(expiredActiveOperationIds({ "op-1": active, "op-2": completed, "op-3": queued }, now)).toEqual(["op-1"]);
    expect(Object.keys(pruneTerminalStates({ "op-1": active, "op-2": completed, "op-3": queued }, now))).toEqual(["op-1", "op-3"]);
  });

  it("records quota as a terminal failure so it cannot be replayed automatically", () => {
    const quotaError = { code: "CHATGPT_LIMIT_REACHED" as const, message: "quota reached" };
    const failed = transitionOperation(state("awaiting_response"), "failed", "2026-07-17T00:03:00.000Z", {
      error: quotaError,
      tabId: undefined,
      deadlineAt: undefined,
    });
    const queues = removeQueuedOperation({ "unit-1": ["op-1"] }, "unit-1", "op-1");
    expect(failed).toMatchObject({ phase: "failed", error: quotaError });
    expect(queues).toEqual({});
    expect(retryDecision(failed)).toBe("requeue");
  });
});
