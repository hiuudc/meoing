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

export function removeSessionLesson(
  state: LearningSessionState,
  unitId: string,
  lessonId: string,
): LearningSessionState {
  const activeLessonMatches = state.lessonsByUnit[unitId]?.id === lessonId;
  const hasProgress = Boolean(state.progressByLesson[lessonId]);
  const summaryMatches = state.unitSummaries[unitId]?.lastLessonId === lessonId;
  if (!activeLessonMatches && !hasProgress && !summaryMatches) return state;

  const lessonsByUnit = { ...state.lessonsByUnit };
  const progressByLesson = { ...state.progressByLesson };
  const unitSummaries = { ...state.unitSummaries };
  if (activeLessonMatches) delete lessonsByUnit[unitId];
  if (hasProgress) delete progressByLesson[lessonId];
  if (summaryMatches) delete unitSummaries[unitId];
  return { lessonsByUnit, progressByLesson, unitSummaries };
}
