import type { ChatOperationPhase, ChatOperationState, ExtensionError } from "../src/integration/protocol";
import type { OperationStateMap, PersistedOperationState, QueueMap, QueuedOperation } from "./shared";

export const OPERATION_RESULT_TTL_MS = 24 * 60 * 60 * 1_000;
export const OPERATION_DEADLINE_MS = 10 * 60 * 1_000;
export const MAX_OUTSTANDING_OPERATIONS = 4;

export function isTerminalPhase(phase: ChatOperationPhase): boolean {
  return phase === "completed" || phase === "failed";
}

export function sameQueuedOperation(left: QueuedOperation, right: QueuedOperation): boolean {
  return left.unitId === right.unitId
    && left.operationId === right.operationId
    && left.kind === right.kind
    && left.prompt === right.prompt
    && JSON.stringify(left.expectation) === JSON.stringify(right.expectation);
}

export type EnqueueDecision = "enqueue" | "existing" | "conflict" | "full";
export type RetryDecision = "missing" | "existing" | "completed" | "requeue";

export function enqueueDecision(
  states: OperationStateMap,
  operation: QueuedOperation,
  maximum = MAX_OUTSTANDING_OPERATIONS,
): EnqueueDecision {
  const existing = states[operation.operationId];
  if (existing) return sameQueuedOperation(existing.operation, operation) ? "existing" : "conflict";
  const outstanding = Object.values(states).filter((state) => !isTerminalPhase(state.phase)).length;
  return outstanding >= maximum ? "full" : "enqueue";
}

export function retryDecision(state?: PersistedOperationState): RetryDecision {
  if (!state) return "missing";
  if (state.phase === "completed") return "completed";
  if (!isTerminalPhase(state.phase)) return "existing";
  return "requeue";
}

export function recoverOpeningOperations(
  states: OperationStateMap,
  queues: QueueMap,
  now = new Date().toISOString(),
): { states: OperationStateMap; queues: QueueMap; recoveredOperationIds: string[] } {
  let nextStates = states;
  let nextQueues = queues;
  const recoveredOperationIds: string[] = [];
  Object.values(states).forEach((state) => {
    if (state.phase !== "opening_chat") return;
    if (nextStates === states) nextStates = { ...states };
    nextStates[state.operationId] = transitionOperation(state, "queued", now, { tabId: undefined, deadlineAt: undefined });
    nextQueues = appendQueuedOperation(nextQueues, state.unitId, state.operationId);
    recoveredOperationIds.push(state.operationId);
  });
  return { states: nextStates, queues: nextQueues, recoveredOperationIds };
}

export function failOperationsForTabState(
  states: OperationStateMap,
  queues: QueueMap,
  tabId: number,
  error: ExtensionError,
  now = new Date().toISOString(),
): { states: OperationStateMap; queues: QueueMap; affectedUnitIds: string[] } {
  let nextStates = states;
  let nextQueues = queues;
  const affectedUnitIds = new Set<string>();
  Object.values(states).forEach((state) => {
    if (state.tabId !== tabId || isTerminalPhase(state.phase)) return;
    if (nextStates === states) nextStates = { ...states };
    nextStates[state.operationId] = transitionOperation(state, "failed", now, { error, tabId: undefined, deadlineAt: undefined });
    nextQueues = removeQueuedOperation(nextQueues, state.unitId, state.operationId);
    affectedUnitIds.add(state.unitId);
  });
  return { states: nextStates, queues: nextQueues, affectedUnitIds: [...affectedUnitIds] };
}

export function acknowledgeTerminalOperation(
  states: OperationStateMap,
  queues: QueueMap,
  operationId: string,
): { states: OperationStateMap; queues: QueueMap; acknowledged: boolean } {
  const state = states[operationId];
  if (!state || !isTerminalPhase(state.phase)) return { states, queues, acknowledged: false };
  const nextStates = { ...states };
  delete nextStates[operationId];
  return {
    states: nextStates,
    queues: removeQueuedOperation(queues, state.unitId, operationId),
    acknowledged: true,
  };
}

export function hasLegacyTransientState(values: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => values[key] !== undefined);
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

function operationTimestamp(state: PersistedOperationState): number {
  const updatedAt = Date.parse(state.updatedAt);
  if (Number.isFinite(updatedAt)) return updatedAt;
  const queuedAt = Date.parse(state.operation.queuedAt);
  return Number.isFinite(queuedAt) ? queuedAt : 0;
}

export function latestUnitOperation(
  states: OperationStateMap,
  unitId: string,
  kind?: QueuedOperation["kind"],
): PersistedOperationState | undefined {
  let latest: PersistedOperationState | undefined;
  Object.values(states).forEach((state) => {
    if (state.unitId !== unitId || (kind && state.operation.kind !== kind)) return;
    const timestamp = operationTimestamp(state);
    const latestTimestamp = latest ? operationTimestamp(latest) : -1;
    if (!latest
      || timestamp > latestTimestamp
      || (timestamp === latestTimestamp && state.operationId.localeCompare(latest.operationId) > 0)
    ) {
      latest = state;
    }
  });
  return latest;
}

export function appendQueuedOperation(queues: QueueMap, unitId: string, operationId: string): QueueMap {
  const current = queues[unitId] ?? [];
  if (current.includes(operationId)) return queues;
  return { ...queues, [unitId]: [...current, operationId] };
}

export function removeQueuedOperation(queues: QueueMap, unitId: string, operationId: string): QueueMap {
  const current = queues[unitId] ?? [];
  const next = current.filter((queuedOperationId) => queuedOperationId !== operationId);
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
