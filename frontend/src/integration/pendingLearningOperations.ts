export const PENDING_LEARNING_OPERATIONS_KEY = "meoi.pendingLearningOperations.v1";
export const PENDING_LEARNING_OPERATIONS_VERSION = 1;
export const PENDING_LEARNING_OPERATION_TTL_MS = 24 * 60 * 60 * 1_000;

export interface PendingLearningOperation {
  operationId: string;
  unitId: string;
  kind: "create_lesson";
  createdAt: string;
}

export interface PendingLearningOperationStore {
  version: typeof PENDING_LEARNING_OPERATIONS_VERSION;
  operationsByUnit: Record<string, PendingLearningOperation>;
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedOperation(
  unitId: string,
  value: unknown,
  now: number,
): PendingLearningOperation | null {
  if (!isRecord(value)
    || value.kind !== "create_lesson"
    || typeof value.operationId !== "string"
    || typeof value.unitId !== "string"
    || value.unitId !== unitId
    || typeof value.createdAt !== "string"
    || !value.operationId.trim()
    || value.operationId.length > 200
    || !value.unitId.trim()
    || value.unitId.length > 200
  ) return null;
  const createdAt = Date.parse(value.createdAt);
  if (!Number.isFinite(createdAt)
    || new Date(createdAt).toISOString() !== value.createdAt
    || createdAt > now + 5 * 60_000
    || now - createdAt > PENDING_LEARNING_OPERATION_TTL_MS
  ) return null;
  return {
    operationId: value.operationId,
    unitId: value.unitId,
    kind: "create_lesson",
    createdAt: value.createdAt,
  };
}

export function createPendingLearningOperationStore(): PendingLearningOperationStore {
  return {
    version: PENDING_LEARNING_OPERATIONS_VERSION,
    operationsByUnit: {},
  };
}

export function normalizePendingLearningOperationStore(
  value: unknown,
  now = Date.now(),
): PendingLearningOperationStore {
  if (!isRecord(value)
    || value.version !== PENDING_LEARNING_OPERATIONS_VERSION
    || !isRecord(value.operationsByUnit)
  ) return createPendingLearningOperationStore();
  const operationsByUnit = Object.fromEntries(
    Object.entries(value.operationsByUnit).flatMap(([unitId, candidate]) => {
      const operation = normalizedOperation(unitId, candidate, now);
      return operation ? [[unitId, operation] as const] : [];
    }),
  );
  return {
    version: PENDING_LEARNING_OPERATIONS_VERSION,
    operationsByUnit,
  };
}

export function loadPendingLearningOperations(
  storage?: StorageReader,
  now = Date.now(),
): PendingLearningOperationStore {
  if (!storage) return createPendingLearningOperationStore();
  try {
    const saved = storage.getItem(PENDING_LEARNING_OPERATIONS_KEY);
    return saved
      ? normalizePendingLearningOperationStore(JSON.parse(saved), now)
      : createPendingLearningOperationStore();
  } catch {
    return createPendingLearningOperationStore();
  }
}

export function savePendingLearningOperations(
  store: PendingLearningOperationStore,
  storage?: StorageWriter,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PENDING_LEARNING_OPERATIONS_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function pendingLearningOperationForUnit(
  store: PendingLearningOperationStore,
  unitId: string,
): PendingLearningOperation | undefined {
  return store.operationsByUnit[unitId];
}

export function putPendingLearningOperation(
  store: PendingLearningOperationStore,
  operation: PendingLearningOperation,
): PendingLearningOperationStore {
  return {
    ...store,
    operationsByUnit: {
      ...store.operationsByUnit,
      [operation.unitId]: operation,
    },
  };
}

export function removePendingLearningOperation(
  store: PendingLearningOperationStore,
  unitId: string,
  operationId?: string,
): PendingLearningOperationStore {
  const current = store.operationsByUnit[unitId];
  if (!current || (operationId && current.operationId !== operationId)) return store;
  const operationsByUnit = { ...store.operationsByUnit };
  delete operationsByUnit[unitId];
  return { ...store, operationsByUnit };
}
