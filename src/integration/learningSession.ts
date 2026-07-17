import type { Lesson, LessonProgressSnapshot } from "../learning/types";

export interface UnitLearningSummary {
  mastery: number;
  commonErrors: string[];
  lastLessonId?: string;
  updatedAt: string;
}

export interface LearningSessionState {
  lessonsByUnit: Record<string, Lesson>;
  progressByLesson: Record<string, LessonProgressSnapshot>;
  unitSummaries: Record<string, UnitLearningSummary>;
}

export function createLearningSession(): LearningSessionState {
  return { lessonsByUnit: {}, progressByLesson: {}, unitSummaries: {} };
}

export function putSessionLesson(state: LearningSessionState, lesson: Lesson): LearningSessionState {
  return { ...state, lessonsByUnit: { ...state.lessonsByUnit, [lesson.unitId]: lesson } };
}

export function putSessionProgress(state: LearningSessionState, snapshot: LessonProgressSnapshot): LearningSessionState {
  const lesson = Object.values(state.lessonsByUnit).find((candidate) => candidate.id === snapshot.lessonId);
  const unitSummaries = lesson
    ? {
        ...state.unitSummaries,
        [lesson.unitId]: {
          ...(state.unitSummaries[lesson.unitId] ?? { commonErrors: [] }),
          mastery: snapshot.masteryPercent,
          lastLessonId: snapshot.lessonId,
          updatedAt: snapshot.updatedAt,
        },
      }
    : state.unitSummaries;
  return { ...state, progressByLesson: { ...state.progressByLesson, [snapshot.lessonId]: snapshot }, unitSummaries };
}
