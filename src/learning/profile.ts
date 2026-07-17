import { QUESTION_FORMATS, type LearningProfile, type QuestionFormat } from "./types";

export const DEFAULT_LEARNING_PROFILE: LearningProfile = {
  targetLanguage: "Japanese",
  interfaceLanguage: "en",
  level: "elementary",
  dailyQuestionGoal: 12,
  lessonQuestionCount: 10,
  speakingEnabled: true,
  preferredFormats: [...QUESTION_FORMATS],
  coachingStyle: "gentle",
};

function validFormats(value: unknown): QuestionFormat[] {
  if (!Array.isArray(value)) return [...DEFAULT_LEARNING_PROFILE.preferredFormats];
  const allowed = new Set<QuestionFormat>(QUESTION_FORMATS);
  const unique = [...new Set(value.filter((format): format is QuestionFormat => typeof format === "string" && allowed.has(format as QuestionFormat)))];
  return unique.length ? unique : [...DEFAULT_LEARNING_PROFILE.preferredFormats];
}

export function normalizeLearningProfile(value?: Partial<LearningProfile> | null): LearningProfile {
  const dailyGoal = typeof value?.dailyQuestionGoal === "number" ? Math.round(value.dailyQuestionGoal) : DEFAULT_LEARNING_PROFILE.dailyQuestionGoal;
  const questionCount = typeof value?.lessonQuestionCount === "number" ? Math.round(value.lessonQuestionCount) : DEFAULT_LEARNING_PROFILE.lessonQuestionCount;
  return {
    ...DEFAULT_LEARNING_PROFILE,
    ...value,
    interfaceLanguage: "en",
    dailyQuestionGoal: Math.min(100, Math.max(1, dailyGoal)),
    lessonQuestionCount: Math.min(15, Math.max(8, questionCount)),
    preferredFormats: validFormats(value?.preferredFormats),
  };
}

export function resolveLearningProfile(
  collectionProfile?: Partial<LearningProfile> | null,
  sessionOverride?: Partial<LearningProfile> | null,
): LearningProfile {
  return normalizeLearningProfile({ ...normalizeLearningProfile(collectionProfile), ...sessionOverride });
}
