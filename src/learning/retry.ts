import type { EvaluationStatus } from "./types";

export interface RetryState {
  queue: string[];
  completed: string[];
  attemptsByQuestion: Record<string, number>;
  firstTryCorrect: number;
}

export function createRetryState(questionIds: string[]): RetryState {
  return { queue: [...questionIds], completed: [], attemptsByQuestion: {}, firstTryCorrect: 0 };
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
    queue: mastered ? remaining : scheduleRetry(remaining, questionId),
    completed: mastered && !state.completed.includes(questionId) ? [...state.completed, questionId] : state.completed,
    attemptsByQuestion: { ...state.attemptsByQuestion, [questionId]: attempts },
    firstTryCorrect: state.firstTryCorrect + (mastered && attempts === 1 ? 1 : 0),
  };
}

export function masteryPercent(state: RetryState, totalQuestions: number): number {
  if (!totalQuestions) return 0;
  return Math.round((state.completed.length / totalQuestions) * 100);
}
