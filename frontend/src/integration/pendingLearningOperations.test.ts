import { describe, expect, it } from "vitest";
import {
  PENDING_LEARNING_OPERATIONS_KEY,
  PENDING_LEARNING_OPERATION_TTL_MS,
  createPendingLearningOperationStore,
  loadPendingLearningOperations,
  normalizePendingLearningOperationStore,
  pendingLearningOperationForUnit,
  putPendingLearningOperation,
  removePendingLearningOperation,
  savePendingLearningOperations,
} from "./pendingLearningOperations";

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

describe("pending learning operations", () => {
  it("persists only resumable create-lesson metadata by unit", () => {
    const storage = memoryStorage();
    const operation = {
      operationId: "operation-1",
      unitId: "unit-1",
      kind: "create_lesson" as const,
      createdAt: new Date("2026-07-27T10:00:00.000Z").toISOString(),
    };
    const next = putPendingLearningOperation(createPendingLearningOperationStore(), operation);
    expect(savePendingLearningOperations(next, storage)).toBe(true);
    expect(JSON.parse(storage.getItem(PENDING_LEARNING_OPERATIONS_KEY)!)).toEqual({
      version: 1,
      operationsByUnit: { "unit-1": operation },
    });
    expect(pendingLearningOperationForUnit(
      loadPendingLearningOperations(storage, Date.parse("2026-07-27T10:05:00.000Z")),
      "unit-1",
    )).toEqual(operation);
  });

  it("drops malformed and expired records without affecting current operations", () => {
    const now = Date.parse("2026-07-27T10:00:00.000Z");
    const current = {
      operationId: "current",
      unitId: "unit-current",
      kind: "create_lesson",
      createdAt: new Date(now - 1_000).toISOString(),
    };
    const expired = {
      operationId: "expired",
      unitId: "unit-expired",
      kind: "create_lesson",
      createdAt: new Date(now - PENDING_LEARNING_OPERATION_TTL_MS - 1).toISOString(),
    };
    const normalized = normalizePendingLearningOperationStore({
      version: 1,
      operationsByUnit: {
        "unit-current": current,
        "unit-expired": expired,
        "unit-wrong": { ...current, unitId: "another-unit" },
      },
    }, now);
    expect(Object.keys(normalized.operationsByUnit)).toEqual(["unit-current"]);
  });

  it("removes only the matching operation", () => {
    const operation = {
      operationId: "operation-1",
      unitId: "unit-1",
      kind: "create_lesson" as const,
      createdAt: new Date().toISOString(),
    };
    const store = putPendingLearningOperation(createPendingLearningOperationStore(), operation);
    expect(removePendingLearningOperation(store, "unit-1", "another-operation")).toBe(store);
    expect(removePendingLearningOperation(store, "unit-1", "operation-1").operationsByUnit).toEqual({});
  });
});
