import { describe, expect, it } from "vitest";
import {
  OPERATION_DEADLINE_MS,
  appendQueuedOperation,
  expiredActiveOperationIds,
  pruneTerminalStates,
  publicOperationState,
  removeQueuedOperation,
  transitionOperation,
} from "./operation-state";
import type { PersistedOperationState, QueuedOperation } from "./shared";

function operation(operationId = "op-1", unitId = "unit-1"): QueuedOperation {
  return {
    id: `queue-${operationId}`,
    command: "SEND_OPERATION",
    unitId,
    operationId,
    kind: "coaching",
    prompt: `prompt ${operationId}`,
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
    const first = appendQueuedOperation({}, operation());
    const duplicate = appendQueuedOperation(first, operation());
    const second = appendQueuedOperation(duplicate, operation("op-2"));
    expect(duplicate).toBe(first);
    expect(second["unit-1"].map((item) => item.operationId)).toEqual(["op-1", "op-2"]);
    expect(removeQueuedOperation(second, "unit-1", "op-1")["unit-1"][0].operationId).toBe("op-2");
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
});
