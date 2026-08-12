import type { EvaluationStatus } from "./types";

export interface RetryState {
  queue: string[];
  completed: string[];
  attemptsByQuestion: Record<string, number>;
  skipsByQuestion: Record<string, number>;
  alternateQuestionIds: string[];
  firstTryCorrect: number;
}

export function createRetryState(questionIds: string[]): RetryState {
  return {
    queue: [...questionIds],
    completed: [],
    attemptsByQuestion: {},
    skipsByQuestion: {},
    alternateQuestionIds: [],
    firstTryCorrect: 0,
  };
}

export function scheduleRetry(remainingQueue: string[], questionId: string, distance = 2): string[] {
  const withoutDuplicate = remainingQueue.filter((id) => id !== questionId);
  const insertAt = Math.min(Math.max(0, distance), withoutDuplicate.length);
  return [...withoutDuplicate.slice(0, insertAt), questionId, ...withoutDuplicate.slice(insertAt)];
}

export function applyAttempt(state: RetryState, questionId: string, status: EvaluationStatus): RetryState {
  const attempts = (state.attemptsByQuestion[questionId] ?? 0) + 1;
  const remaining = state.queue[0] === questionId ? state.queue.slice(1) : state.queue.filter((id) => id !== questionId);
  const mastered = status === "correct";
  return {
    ...state,
    queue: mastered ? remaining : scheduleRetry(remaining, questionId),
    completed: mastered && !state.completed.includes(questionId) ? [...state.completed, questionId] : state.completed,
    attemptsByQuestion: { ...state.attemptsByQuestion, [questionId]: attempts },
    firstTryCorrect: state.firstTryCorrect + (mastered && attempts === 1 ? 1 : 0),
  };
}

export function skipQuestion(state: RetryState, questionId: string, hasAlternate: boolean): RetryState {
  const skips = (state.skipsByQuestion[questionId] ?? 0) + 1;
  const remaining = state.queue[0] === questionId ? state.queue.slice(1) : state.queue.filter((id) => id !== questionId);
  const activateAlternate = hasAlternate && skips > 3 && !state.alternateQuestionIds.includes(questionId);
  return {
    ...state,
    queue: [...remaining, questionId],
    skipsByQuestion: { ...state.skipsByQuestion, [questionId]: skips },
    alternateQuestionIds: activateAlternate
      ? [...state.alternateQuestionIds, questionId]
      : state.alternateQuestionIds,
  };
}

export function useListeningAlternate(state: RetryState, questionId: string, hasAlternate: boolean): RetryState {
  if (!hasAlternate || state.alternateQuestionIds.includes(questionId)) return state;
  const remaining = state.queue[0] === questionId ? state.queue.slice(1) : state.queue.filter((id) => id !== questionId);
  return {
    ...state,
    queue: [...remaining, questionId],
    alternateQuestionIds: [...state.alternateQuestionIds, questionId],
  };
}

export function masteryPercent(state: RetryState, totalQuestions: number): number {
  if (!totalQuestions) return 0;
  return Math.round((state.completed.length / totalQuestions) * 100);
}
