import { describe, expect, it } from "vitest";
import { createLocalPreviewLesson } from "../learning/demoLesson";
import { DEFAULT_LEARNING_PROFILE } from "../learning/profile";
import type { Lesson, LessonProgressSnapshot } from "../learning/types";
import {
  createLocalLearningCache,
  LEARNING_STORAGE_KEY,
  loadLocalLearningCache,
  MAX_STORED_LESSONS_PER_UNIT,
  normalizeLocalLearningCache,
  pruneStoredLessons,
  putStoredLesson,
  putStoredLessonProgress,
  removeStoredLesson,
  saveLocalLearningCache,
} from "./learningStorage";

function lesson(id: string, unitId = "unit-1"): Lesson {
  return {
    ...createLocalPreviewLesson(unitId, "Stored unit", DEFAULT_LEARNING_PROFILE),
    id,
    createdAt: "2026-07-17T00:00:00.000Z",
  };
}

function progress(storedLesson: Lesson, lessonId = storedLesson.id): LessonProgressSnapshot {
  const questionId = storedLesson.questions[0].id;
  return {
    lessonId,
    completedQuestionIds: [questionId],
    attemptsByQuestion: { [questionId]: 1 },
    firstTryCorrect: 1,
    totalQuestions: storedLesson.questions.length,
    masteryPercent: 10,
    updatedAt: "2026-07-17T01:00:00.000Z",
  };
}

function memoryStorage(initial?: string) {
  let saved = initial ?? null;
  return {
    getItem(key: string) {
      return key === LEARNING_STORAGE_KEY ? saved : null;
    },
    setItem(key: string, value: string) {
      if (key === LEARNING_STORAGE_KEY) saved = value;
    },
    value() {
      return saved;
    },
  };
}

describe("local learning cache", () => {
  it("falls back safely for missing, malformed, and wrong-version data", () => {
    expect(loadLocalLearningCache(memoryStorage())).toEqual(createLocalLearningCache());
    expect(loadLocalLearningCache(memoryStorage("{"))).toEqual(createLocalLearningCache());
    expect(loadLocalLearningCache(memoryStorage(JSON.stringify({ version: 2, lessonsByUnit: {} }))))
      .toEqual(createLocalLearningCache());
  });

  it("keeps only fully valid entries that match their unit and progress lesson", () => {
    const validLesson = lesson("lesson-valid");
    const wrongUnit = lesson("lesson-wrong-unit", "unit-2");
    const normalized = normalizeLocalLearningCache({
      version: 1,
      lessonsByUnit: {
        "unit-1": [
          { lesson: validLesson, progress: progress(validLesson), savedAt: "2026-07-17T02:00:00.000Z" },
          { lesson: wrongUnit, savedAt: "2026-07-17T03:00:00.000Z" },
          { lesson: validLesson, progress: progress(validLesson, "another-lesson"), savedAt: "2026-07-17T04:00:00.000Z" },
          { lesson: { ...validLesson, unexpected: true }, savedAt: "2026-07-17T05:00:00.000Z" },
          { lesson: validLesson, progress: { ...progress(validLesson), totalQuestions: 9 }, savedAt: "2026-07-17T06:00:00.000Z" },
        ],
      },
    });

    expect(normalized.lessonsByUnit["unit-1"]).toHaveLength(1);
    expect(normalized.lessonsByUnit["unit-1"][0]).toMatchObject({
      lesson: { id: "lesson-valid", unitId: "unit-1" },
      progress: { lessonId: "lesson-valid", masteryPercent: 10 },
    });
  });

  it("sorts newest first, deduplicates IDs, and caps each unit at five lessons", () => {
    const rawEntries = Array.from({ length: 7 }, (_, index) => ({
      lesson: lesson(`lesson-${index}`),
      savedAt: `2026-07-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
    }));
    rawEntries.push({ lesson: lesson("lesson-6"), savedAt: "2026-07-01T00:00:00.000Z" });
    const normalized = normalizeLocalLearningCache({ version: 1, lessonsByUnit: { "unit-1": rawEntries } });

    expect(normalized.lessonsByUnit["unit-1"]).toHaveLength(MAX_STORED_LESSONS_PER_UNIT);
    expect(normalized.lessonsByUnit["unit-1"].map((entry) => entry.lesson.id))
      .toEqual(["lesson-6", "lesson-5", "lesson-4", "lesson-3", "lesson-2"]);
  });

  it("puts a new lesson first, replaces duplicate IDs, and updates only matching progress", () => {
    let cache = createLocalLearningCache();
    for (let index = 0; index < 6; index += 1) {
      cache = putStoredLesson(cache, lesson(`lesson-${index}`), `2026-07-17T00:00:0${index}.000Z`);
    }
    expect(cache.lessonsByUnit["unit-1"].map((entry) => entry.lesson.id))
      .toEqual(["lesson-5", "lesson-4", "lesson-3", "lesson-2", "lesson-1"]);

    const replacement = { ...lesson("lesson-3"), title: "Replacement" };
    cache = putStoredLesson(cache, replacement, "2026-07-17T02:00:00.000Z");
    expect(cache.lessonsByUnit["unit-1"][0].lesson.title).toBe("Replacement");
    expect(cache.lessonsByUnit["unit-1"].filter((entry) => entry.lesson.id === "lesson-3")).toHaveLength(1);

    const unchanged = putStoredLessonProgress(cache, "unit-1", progress(lesson("missing")));
    expect(unchanged).toBe(cache);
    cache = putStoredLessonProgress(cache, "unit-1", progress(replacement));
    expect(cache.lessonsByUnit["unit-1"][0].progress?.masteryPercent).toBe(10);
    expect(cache.lessonsByUnit["unit-1"][0].lastStudiedAt).toBe("2026-07-17T01:00:00.000Z");
  });

  it("prunes deleted units without changing valid histories", () => {
    let cache = putStoredLesson(createLocalLearningCache(), lesson("lesson-1", "unit-1"));
    cache = putStoredLesson(cache, lesson("lesson-2", "unit-2"));
    const pruned = pruneStoredLessons(cache, new Set(["unit-2"]));
    expect(Object.keys(pruned.lessonsByUnit)).toEqual(["unit-2"]);
    expect(pruneStoredLessons(pruned, new Set(["unit-2"]))).toBe(pruned);
  });

  it("removes only the requested lesson and drops empty unit histories", () => {
    let cache = putStoredLesson(createLocalLearningCache(), lesson("lesson-1"));
    cache = putStoredLesson(cache, lesson("lesson-2"));

    const unchanged = removeStoredLesson(cache, "unit-1", "missing");
    expect(unchanged).toBe(cache);

    cache = removeStoredLesson(cache, "unit-1", "lesson-1");
    expect(cache.lessonsByUnit["unit-1"].map((entry) => entry.lesson.id)).toEqual(["lesson-2"]);

    cache = removeStoredLesson(cache, "unit-1", "lesson-2");
    expect(cache.lessonsByUnit["unit-1"]).toBeUndefined();
  });

  it("reports storage quota failures without mutating the in-memory cache", () => {
    const cache = putStoredLesson(createLocalLearningCache(), lesson("lesson-1"));
    const quotaStorage = {
      setItem() {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
    };
    expect(saveLocalLearningCache(cache, quotaStorage)).toBe(false);
    expect(cache.lessonsByUnit["unit-1"]).toHaveLength(1);

    const storage = memoryStorage();
    expect(saveLocalLearningCache(cache, storage)).toBe(true);
    expect(JSON.parse(storage.value() ?? "null").lessonsByUnit["unit-1"]).toHaveLength(1);
  });
});
