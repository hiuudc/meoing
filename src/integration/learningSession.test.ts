import { describe, expect, it } from "vitest";
import { createLocalPreviewLesson } from "../learning/demoLesson";
import { DEFAULT_LEARNING_PROFILE } from "../learning/profile";
import type { LessonProgressSnapshot } from "../learning/types";
import {
  createLearningSession,
  putSessionLesson,
  putSessionProgress,
  removeSessionLesson,
} from "./learningSession";

describe("learning session", () => {
  it("removes a lesson with its progress and matching unit summary", () => {
    const lesson = createLocalPreviewLesson("unit-1", "Unit", DEFAULT_LEARNING_PROFILE);
    const questionId = lesson.questions[0].id;
    const progress: LessonProgressSnapshot = {
      lessonId: lesson.id,
      completedQuestionIds: [questionId],
      attemptsByQuestion: { [questionId]: 1 },
      firstTryCorrect: 1,
      totalQuestions: lesson.questions.length,
      masteryPercent: 10,
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    const session = putSessionProgress(putSessionLesson(createLearningSession(), lesson), progress);

    const removed = removeSessionLesson(session, lesson.unitId, lesson.id);
    expect(removed.lessonsByUnit[lesson.unitId]).toBeUndefined();
    expect(removed.progressByLesson[lesson.id]).toBeUndefined();
    expect(removed.unitSummaries[lesson.unitId]).toBeUndefined();
    expect(removeSessionLesson(removed, lesson.unitId, lesson.id)).toBe(removed);
  });
});
