import { lessonProgressSnapshotSchema, lessonSchema } from "../learning/schema";
import type { Lesson, LessonProgressSnapshot } from "../learning/types";

export const LEARNING_STORAGE_KEY = "meoi.learning.v1";
export const LEARNING_STORAGE_VERSION = 1;
export const MAX_STORED_LESSONS_PER_UNIT = 5;

export interface StoredLessonEntry {
  lesson: Lesson;
  progress?: LessonProgressSnapshot;
  savedAt: string;
  lastStudiedAt?: string;
}

export interface LocalLearningCache {
  version: typeof LEARNING_STORAGE_VERSION;
  lessonsByUnit: Record<string, StoredLessonEntry[]>;
}

type LearningStorageReader = Pick<Storage, "getItem">;
type LearningStorageWriter = Pick<Storage, "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function entryTimestamp(entry: StoredLessonEntry): number {
  return Date.parse(entry.savedAt);
}

function normalizeUnitEntries(unitId: string, value: unknown): StoredLessonEntry[] {
  if (!Array.isArray(value)) return [];
  const parsed = value.flatMap((candidate): StoredLessonEntry[] => {
    if (!isRecord(candidate) || !isIsoDate(candidate.savedAt)) return [];
    const lesson = lessonSchema.safeParse(candidate.lesson);
    if (!lesson.success || lesson.data.unitId !== unitId) return [];

    let progress: LessonProgressSnapshot | undefined;
    if (candidate.progress !== undefined) {
      const parsedProgress = lessonProgressSnapshotSchema.safeParse(candidate.progress);
      if (!parsedProgress.success || parsedProgress.data.lessonId !== lesson.data.id) return [];
      const questionIds = new Set(lesson.data.questions.map((question) => question.id));
      if (
        parsedProgress.data.totalQuestions !== lesson.data.questions.length
        || parsedProgress.data.completedQuestionIds.some((questionId) => !questionIds.has(questionId))
        || Object.keys(parsedProgress.data.attemptsByQuestion).some((questionId) => !questionIds.has(questionId))
      ) return [];
      progress = parsedProgress.data as LessonProgressSnapshot;
    }

    if (candidate.lastStudiedAt !== undefined && !isIsoDate(candidate.lastStudiedAt)) return [];
    return [{
      lesson: lesson.data as Lesson,
      progress,
      savedAt: candidate.savedAt,
      lastStudiedAt: candidate.lastStudiedAt as string | undefined,
    }];
  });

  parsed.sort((left, right) => entryTimestamp(right) - entryTimestamp(left));
  const seenLessonIds = new Set<string>();
  return parsed.filter((entry) => {
    if (seenLessonIds.has(entry.lesson.id)) return false;
    seenLessonIds.add(entry.lesson.id);
    return true;
  }).slice(0, MAX_STORED_LESSONS_PER_UNIT);
}

export function createLocalLearningCache(): LocalLearningCache {
  return { version: LEARNING_STORAGE_VERSION, lessonsByUnit: {} };
}

export function normalizeLocalLearningCache(value: unknown): LocalLearningCache {
  if (!isRecord(value) || value.version !== LEARNING_STORAGE_VERSION || !isRecord(value.lessonsByUnit)) {
    return createLocalLearningCache();
  }
  const lessonsByUnit = Object.fromEntries(
    Object.entries(value.lessonsByUnit).flatMap(([unitId, entries]) => {
      if (!unitId.trim()) return [];
      const normalized = normalizeUnitEntries(unitId, entries);
      return normalized.length ? [[unitId, normalized] as const] : [];
    }),
  );
  return { version: LEARNING_STORAGE_VERSION, lessonsByUnit };
}

export function loadLocalLearningCache(storage?: LearningStorageReader): LocalLearningCache {
  if (!storage) return createLocalLearningCache();
  try {
    const saved = storage.getItem(LEARNING_STORAGE_KEY);
    return saved ? normalizeLocalLearningCache(JSON.parse(saved)) : createLocalLearningCache();
  } catch {
    return createLocalLearningCache();
  }
}

export function saveLocalLearningCache(cache: LocalLearningCache, storage?: LearningStorageWriter): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LEARNING_STORAGE_KEY, JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

export function putStoredLesson(
  cache: LocalLearningCache,
  lesson: Lesson,
  savedAt = new Date().toISOString(),
): LocalLearningCache {
  const current = cache.lessonsByUnit[lesson.unitId] ?? [];
  const entries = [
    { lesson, savedAt },
    ...current.filter((entry) => entry.lesson.id !== lesson.id),
  ].slice(0, MAX_STORED_LESSONS_PER_UNIT);
  return {
    ...cache,
    lessonsByUnit: { ...cache.lessonsByUnit, [lesson.unitId]: entries },
  };
}

export function putStoredLessonProgress(
  cache: LocalLearningCache,
  unitId: string,
  progress: LessonProgressSnapshot,
  lastStudiedAt = progress.updatedAt,
): LocalLearningCache {
  const current = cache.lessonsByUnit[unitId];
  if (!current?.some((entry) => entry.lesson.id === progress.lessonId)) return cache;
  return {
    ...cache,
    lessonsByUnit: {
      ...cache.lessonsByUnit,
      [unitId]: current.map((entry) => entry.lesson.id === progress.lessonId
        ? { ...entry, progress, lastStudiedAt }
        : entry),
    },
  };
}

export function pruneStoredLessons(
  cache: LocalLearningCache,
  validUnitIds: ReadonlySet<string>,
): LocalLearningCache {
  const lessonsByUnit = Object.fromEntries(
    Object.entries(cache.lessonsByUnit).filter(([unitId]) => validUnitIds.has(unitId)),
  );
  return Object.keys(lessonsByUnit).length === Object.keys(cache.lessonsByUnit).length
    ? cache
    : { ...cache, lessonsByUnit };
}

export function pruneStoredLessonsFromStorage(
  storage: LearningStorageReader & LearningStorageWriter,
  validUnitIds: ReadonlySet<string>,
): boolean {
  const current = loadLocalLearningCache(storage);
  const next = pruneStoredLessons(current, validUnitIds);
  return next === current || saveLocalLearningCache(next, storage);
}
