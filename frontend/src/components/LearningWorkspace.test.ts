import { describe, expect, it } from "vitest";
import {
  canDeleteStoredLesson,
  progressSnapshotFromWire,
  publicLearningError,
} from "./LearningWorkspace";
import type { Lesson } from "../learning/types";

const lesson = {
  id: "lesson-1",
  unitId: "unit-1",
  questions: [{ id: "question-1" }],
} as unknown as Lesson;

describe("LearningWorkspace API-first helpers", () => {
  it("keeps deletion restricted to the owner or collection content managers", () => {
    expect(canDeleteStoredLesson({ ownerId: "user-1", status: "draft" }, "user-1", false)).toBe(true);
    expect(canDeleteStoredLesson({ ownerId: "user-1", status: "published" }, "user-1", false)).toBe(false);
    expect(canDeleteStoredLesson({ ownerId: "user-1", status: "published" }, "user-2", true)).toBe(true);
  });

  it("derives server-synced progress without trusting unknown question ids", () => {
    const snapshot = progressSnapshotFromWire(lesson, {
      id: "progress-1",
      lessonId: "lesson-1",
      startedAt: "2026-08-12T00:00:00.000Z",
      attempts: [
        { questionId: "question-1", attemptNumber: 1, status: "correct" },
        { questionId: "unknown", attemptNumber: 1, status: "correct" },
      ],
    });
    expect(snapshot?.completedQuestionIds).toEqual(["question-1"]);
    expect(snapshot?.masteryPercent).toBe(100);
  });

  it("does not expose provider implementation details in user-facing errors", () => {
    expect(publicLearningError(new Error("Request failed"))).toBe("Request failed");
  });
});
