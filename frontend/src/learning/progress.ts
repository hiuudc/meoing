import type { AttemptRecord } from "./types";

export const PROGRESS_BATCH_SIZE = 5;

export interface ProgressBatchDecision {
  pending: AttemptRecord[];
  lessonComplete: boolean;
  pageHidden: boolean;
}

export function shouldFlushProgress({ pending, lessonComplete, pageHidden }: ProgressBatchDecision): boolean {
  return pending.length >= PROGRESS_BATCH_SIZE || (pending.length > 0 && (lessonComplete || pageHidden));
}

export function firstTryAccuracy(attempts: AttemptRecord[], totalQuestions: number): number {
  if (!totalQuestions) return 0;
  const firstAttempts = new Map<string, AttemptRecord>();
  attempts.forEach((attempt) => {
    if (!firstAttempts.has(attempt.questionId)) firstAttempts.set(attempt.questionId, attempt);
  });
  const correct = [...firstAttempts.values()].filter((attempt) => attempt.status === "correct").length;
  return Math.round((correct / totalQuestions) * 100);
}
