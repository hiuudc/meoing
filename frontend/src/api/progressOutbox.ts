import type { AttemptRecord, LessonProgressSnapshot } from "../learning/types";
import { ApiError, type ApiClient } from "./client";

const DATABASE_NAME = "meoing-progress-outbox";
const DATABASE_VERSION = 1;
const STORE_NAME = "progress-batches";

export interface ProgressEvent {
  eventId: string;
  attemptId: string;
  questionId: string;
  attemptNumber: number;
  answer: AttemptRecord["answer"];
  evaluationSource: AttemptRecord["evaluationSource"];
  status: AttemptRecord["status"];
  outcome: NonNullable<AttemptRecord["outcome"]>;
  transcript?: string | null;
  score: number;
  firstTry: boolean;
  answeredAt: string;
}

export interface ProgressBatchPayload {
  batchId: string;
  events: ProgressEvent[];
  snapshot: LessonProgressSnapshot;
}

interface ProgressOutboxRecord {
  batchId: string;
  userId: string;
  progressId: string;
  payload: ProgressBatchPayload;
  createdAt: string;
  state?: "pending" | "quarantined";
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface ProgressOutboxIssue {
  batchId: string;
  progressId: string;
  createdAt: string;
  code: string;
  message: string;
}

export interface ProgressOutboxFlushResult {
  acknowledged: number;
  retryableFailures: number;
  quarantined: number;
}

function databaseAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!databaseAvailable()) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open the progress outbox."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "batchId" });
        store.createIndex("userId", "userId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("The progress outbox transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("The progress outbox transaction was aborted."));
  });
}

export function buildProgressBatch(
  attempts: AttemptRecord[],
  snapshot: LessonProgressSnapshot,
  batchId: string = crypto.randomUUID(),
): ProgressBatchPayload {
  return {
    batchId,
    events: attempts.map((attempt) => ({
      eventId: crypto.randomUUID(),
      attemptId: attempt.attemptId,
      questionId: attempt.questionId,
      attemptNumber: attempt.attemptNumber,
      answer: attempt.answer,
      evaluationSource: attempt.evaluationSource,
      status: attempt.status,
      outcome: attempt.outcome ?? (attempt.status === "correct" ? "correct" : "incorrect"),
      ...(attempt.transcript === undefined ? {} : { transcript: attempt.transcript }),
      score: attempt.score,
      firstTry: attempt.firstTry,
      answeredAt: attempt.answeredAt,
    })),
    snapshot,
  };
}

export async function enqueueProgressBatch(
  userId: string,
  progressId: string,
  payload: ProgressBatchPayload,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).add({
      batchId: payload.batchId,
      userId,
      progressId,
      payload,
      createdAt: new Date().toISOString(),
      state: "pending",
    } satisfies ProgressOutboxRecord);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

async function recordsForUser(userId: string): Promise<ProgressOutboxRecord[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).index("userId").getAll(userId);
    const records = await new Promise<ProgressOutboxRecord[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as ProgressOutboxRecord[]);
      request.onerror = () => reject(request.error ?? new Error("Could not read pending progress."));
    });
    await transactionComplete(transaction);
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  } finally {
    database.close();
  }
}

async function acknowledgeBatch(batchId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(batchId);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

async function updateBatch(
  batchId: string,
  update: (record: ProgressOutboxRecord) => ProgressOutboxRecord | undefined,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(batchId);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const record = request.result as ProgressOutboxRecord | undefined;
        if (record) {
          const next = update(record);
          if (next) store.put(next);
          else store.delete(batchId);
        }
        resolve();
      };
      request.onerror = () => reject(request.error ?? new Error("Could not update pending progress."));
    });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

function isTerminalProgressError(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![401, 408, 425, 429].includes(error.status);
}

export async function listProgressOutboxIssues(userId: string): Promise<ProgressOutboxIssue[]> {
  if (!databaseAvailable()) return [];
  return (await recordsForUser(userId))
    .filter((record) => record.state === "quarantined")
    .map((record) => ({
      batchId: record.batchId,
      progressId: record.progressId,
      createdAt: record.createdAt,
      code: record.lastErrorCode ?? "PROGRESS_BATCH_REJECTED",
      message: record.lastErrorMessage ?? "The server rejected this progress batch.",
    }));
}

export async function retryProgressOutboxIssues(userId: string): Promise<number> {
  if (!databaseAvailable()) return 0;
  const records = (await recordsForUser(userId)).filter((record) => record.state === "quarantined");
  for (const record of records) {
    await updateBatch(record.batchId, (current) => ({
      ...current,
      state: "pending",
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    }));
  }
  return records.length;
}

export async function discardProgressOutboxIssues(userId: string): Promise<number> {
  if (!databaseAvailable()) return 0;
  const records = (await recordsForUser(userId)).filter((record) => record.state === "quarantined");
  for (const record of records) await acknowledgeBatch(record.batchId);
  return records.length;
}

export async function clearProgressOutboxForUser(userId: string): Promise<number> {
  if (!databaseAvailable()) return 0;
  const records = await recordsForUser(userId);
  for (const record of records) await acknowledgeBatch(record.batchId);
  return records.length;
}

export async function flushProgressOutbox(
  api: ApiClient,
  userId: string,
): Promise<ProgressOutboxFlushResult> {
  if (!databaseAvailable()) {
    return { acknowledged: 0, retryableFailures: 0, quarantined: 0 };
  }
  const records = await recordsForUser(userId);
  const result: ProgressOutboxFlushResult = {
    acknowledged: 0,
    retryableFailures: 0,
    quarantined: records.filter((record) => record.state === "quarantined").length,
  };
  for (const record of records) {
    if (record.state === "quarantined") continue;
    try {
      await api.post(
        `/v1/progress/${encodeURIComponent(record.progressId)}/batches`,
        record.payload,
      );
      await acknowledgeBatch(record.batchId);
      result.acknowledged += 1;
    } catch (error) {
      if (isTerminalProgressError(error)) {
        await updateBatch(record.batchId, (current) => ({
          ...current,
          state: "quarantined",
          lastErrorCode: error.code,
          lastErrorMessage: error.message,
        }));
        result.quarantined += 1;
      } else {
        result.retryableFailures += 1;
      }
    }
  }
  return result;
}
