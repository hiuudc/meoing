import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "./client";
import {
  buildProgressBatch,
  clearProgressOutboxForUser,
  discardProgressOutboxIssues,
  enqueueProgressBatch,
  flushProgressOutbox,
  listProgressOutboxIssues,
  retryProgressOutboxIssues,
  type ProgressBatchPayload,
} from "./progressOutbox";
import type { AttemptRecord, LessonProgressSnapshot } from "../learning/types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_USER_ID = "00000000-0000-4000-8000-000000000004";
const PROGRESS_ID = "00000000-0000-4000-8000-000000000002";

function resetDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("meoing-progress-outbox");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("The test outbox database is blocked."));
  });
}

function batch(batchId: string): ProgressBatchPayload {
  return {
    batchId,
    events: [{
      eventId: `${batchId.slice(0, -1)}9`,
      attemptId: `${batchId.slice(0, -1)}8`,
      questionId: "question-1",
      attemptNumber: 1,
      answer: { optionId: "answer-1" },
      evaluationSource: "client_extension",
      status: "correct",
      outcome: "correct",
      score: 1,
      firstTry: true,
      answeredAt: "2026-07-30T10:00:00.000Z",
    }],
    snapshot: {
      lessonId: "00000000-0000-4000-8000-000000000003",
      completedQuestionIds: ["question-1"],
      attemptsByQuestion: { "question-1": 1 },
      firstTryCorrect: 1,
      totalQuestions: 1,
      masteryPercent: 100,
      updatedAt: "2026-07-30T10:00:00.000Z",
    },
  };
}

describe("progress outbox payload", () => {
  beforeEach(resetDatabase);

  it("preserves transcript/raw status and derives an aggregation-compatible outcome", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const attempt: AttemptRecord = {
      attemptId: "attempt-1",
      questionId: "question-1",
      attemptNumber: 1,
      answer: { optionId: "answer-1" },
      evaluationSource: "client_extension",
      status: "partial",
      transcript: "Good morning",
      score: 0.5,
      firstTry: true,
      answeredAt: "2026-07-30T10:00:00.000Z",
    };
    const snapshot: LessonProgressSnapshot = {
      lessonId: "lesson-1",
      completedQuestionIds: ["question-1"],
      attemptsByQuestion: { "question-1": 1 },
      firstTryCorrect: 1,
      totalQuestions: 1,
      masteryPercent: 100,
      updatedAt: "2026-07-30T10:00:00.000Z",
    };

    expect(buildProgressBatch([attempt], snapshot, "batch-1")).toEqual({
      batchId: "batch-1",
      events: [{
        eventId: "00000000-0000-4000-8000-000000000001",
        attemptId: "attempt-1",
        questionId: "question-1",
        attemptNumber: 1,
        answer: { optionId: "answer-1" },
        evaluationSource: "client_extension",
        status: "partial",
        outcome: "incorrect",
        transcript: "Good morning",
        score: 0.5,
        firstTry: true,
        answeredAt: "2026-07-30T10:00:00.000Z",
      }],
      snapshot,
    });

    expect(buildProgressBatch([{ ...attempt, outcome: "skipped" }], snapshot, "batch-2")
      .events[0].outcome).toBe("skipped");
  });

  it("deletes acknowledged batches immediately", async () => {
    const payload = batch("00000000-0000-4000-8000-000000000011");
    await enqueueProgressBatch(USER_ID, PROGRESS_ID, payload);
    const post = vi.fn().mockResolvedValue({ data: {} });

    await expect(flushProgressOutbox({ post } as unknown as ApiClient, USER_ID)).resolves.toEqual({
      acknowledged: 1,
      retryableFailures: 0,
      quarantined: 0,
    });
    await expect(flushProgressOutbox({ post } as unknown as ApiClient, USER_ID)).resolves.toEqual({
      acknowledged: 0,
      retryableFailures: 0,
      quarantined: 0,
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps transient failures pending and retries them later", async () => {
    const payload = batch("00000000-0000-4000-8000-000000000021");
    await enqueueProgressBatch(USER_ID, PROGRESS_ID, payload);
    const post = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: {} });
    const api = { post } as unknown as ApiClient;

    await expect(flushProgressOutbox(api, USER_ID)).resolves.toMatchObject({
      acknowledged: 0,
      retryableFailures: 1,
    });
    await expect(flushProgressOutbox(api, USER_ID)).resolves.toMatchObject({
      acknowledged: 1,
      retryableFailures: 0,
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("quarantines a permanent poison batch without blocking newer progress", async () => {
    const poison = batch("00000000-0000-4000-8000-000000000031");
    const valid = batch("00000000-0000-4000-8000-000000000032");
    await enqueueProgressBatch(USER_ID, PROGRESS_ID, poison);
    await enqueueProgressBatch(USER_ID, PROGRESS_ID, valid);
    const post = vi.fn().mockImplementation((_path: string, payload: ProgressBatchPayload) => {
      if (payload.batchId === poison.batchId) {
        throw new ApiError(400, { code: "INVALID_PROGRESS_EVENT", message: "Invalid progress event." });
      }
      return Promise.resolve({ data: {} });
    });
    const api = { post } as unknown as ApiClient;

    await expect(flushProgressOutbox(api, USER_ID)).resolves.toEqual({
      acknowledged: 1,
      retryableFailures: 0,
      quarantined: 1,
    });
    await expect(listProgressOutboxIssues(USER_ID)).resolves.toEqual([expect.objectContaining({
      batchId: poison.batchId,
      code: "INVALID_PROGRESS_EVENT",
    })]);

    post.mockResolvedValue({ data: {} });
    await expect(retryProgressOutboxIssues(USER_ID)).resolves.toBe(1);
    await expect(flushProgressOutbox(api, USER_ID)).resolves.toMatchObject({ acknowledged: 1, quarantined: 0 });
    await expect(listProgressOutboxIssues(USER_ID)).resolves.toEqual([]);
  });

  it("lets the user intentionally discard a quarantined batch", async () => {
    const payload = batch("00000000-0000-4000-8000-000000000041");
    await enqueueProgressBatch(USER_ID, PROGRESS_ID, payload);
    const api = {
      post: vi.fn().mockRejectedValue(new ApiError(409, {
        code: "PROGRESS_ALREADY_CLOSED",
        message: "Progress is closed.",
      })),
    } as unknown as ApiClient;

    await flushProgressOutbox(api, USER_ID);
    await expect(discardProgressOutboxIssues(USER_ID)).resolves.toBe(1);
    await expect(listProgressOutboxIssues(USER_ID)).resolves.toEqual([]);
  });

  it("clears every pending and quarantined batch for only the requested user", async () => {
    await enqueueProgressBatch(
      USER_ID,
      PROGRESS_ID,
      batch("00000000-0000-4000-8000-000000000051"),
    );
    await flushProgressOutbox({
      post: vi.fn().mockRejectedValue(new ApiError(400, {
        code: "INVALID_PROGRESS_EVENT",
        message: "Invalid progress event.",
      })),
    } as unknown as ApiClient, USER_ID);
    await enqueueProgressBatch(
      USER_ID,
      PROGRESS_ID,
      batch("00000000-0000-4000-8000-000000000052"),
    );
    await enqueueProgressBatch(
      SECOND_USER_ID,
      PROGRESS_ID,
      batch("00000000-0000-4000-8000-000000000053"),
    );

    await expect(clearProgressOutboxForUser(USER_ID)).resolves.toBe(2);
    const post = vi.fn().mockResolvedValue({ data: {} });
    const api = { post } as unknown as ApiClient;
    await expect(flushProgressOutbox(api, USER_ID)).resolves.toMatchObject({ acknowledged: 0 });
    await expect(flushProgressOutbox(api, SECOND_USER_ID)).resolves.toMatchObject({ acknowledged: 1 });
    expect(post).toHaveBeenCalledOnce();
  });
});
