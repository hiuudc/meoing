import type { ChatOperationPhase, ChatOperationState } from "../src/integration/protocol";
import type { OperationStateMap, PersistedOperationState, QueueMap, QueuedOperation } from "./shared";

export const OPERATION_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
export const OPERATION_DEADLINE_MS = 10 * 60 * 1_000;

export function isTerminalPhase(phase: ChatOperationPhase): boolean {
  return phase === "completed" || phase === "failed";
}

export function publicOperationState(state: PersistedOperationState): ChatOperationState {
  return {
    operationId: state.operationId,
    unitId: state.unitId,
    phase: state.phase,
    repairAttempt: state.repairAttempt,
    updatedAt: state.updatedAt,
    result: state.result,
    error: state.error,
  };
}

export function appendQueuedOperation(queues: QueueMap, operation: QueuedOperation): QueueMap {
  const current = queues[operation.unitId] ?? [];
  if (current.some((candidate) => candidate.operationId === operation.operationId)) return queues;
  return { ...queues, [operation.unitId]: [...current, operation] };
}

export function removeQueuedOperation(queues: QueueMap, unitId: string, operationId: string): QueueMap {
  const current = queues[unitId] ?? [];
  const next = current.filter((operation) => operation.operationId !== operationId);
  if (next.length === current.length) return queues;
  const updated = { ...queues };
  if (next.length) updated[unitId] = next;
  else delete updated[unitId];
  return updated;
}

export function transitionOperation(
  state: PersistedOperationState,
  phase: ChatOperationPhase,
  now = new Date().toISOString(),
  patch: Partial<Omit<PersistedOperationState, "operationId" | "unitId" | "operation" | "phase" | "updatedAt">> = {},
): PersistedOperationState {
  return { ...state, ...patch, phase, updatedAt: now };
}

export function pruneTerminalStates(
  states: OperationStateMap,
  nowMs = Date.now(),
  ttlMs = OPERATION_RESULT_TTL_MS,
): OperationStateMap {
  let changed = false;
  const next: OperationStateMap = {};
  Object.entries(states).forEach(([operationId, state]) => {
    const updatedAt = Date.parse(state.updatedAt);
    const expired = isTerminalPhase(state.phase) && Number.isFinite(updatedAt) && nowMs - updatedAt >= ttlMs;
    if (expired) changed = true;
    else next[operationId] = state;
  });
  return changed ? next : states;
}

export function expiredActiveOperationIds(states: OperationStateMap, nowMs = Date.now()): string[] {
  return Object.values(states)
    .filter((state) => !isTerminalPhase(state.phase) && state.phase !== "queued" && typeof state.deadlineAt === "number" && state.deadlineAt <= nowMs)
    .map((state) => state.operationId);
}
