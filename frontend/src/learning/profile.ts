import { LESSON_QUESTION_FORMATS, type LearningProfile, type QuestionFormat } from "./types";
import { canonicalLanguageName, normalizeSourceLanguage } from "./languages";

export const DEFAULT_LEARNING_PROFILE: LearningProfile = {
  targetLanguage: "Japanese",
  sourceLanguage: "English",
  interfaceLanguage: "en",
  level: "elementary",
  dailyQuestionGoal: 12,
  lessonQuestionCount: 10,
  speakingEnabled: true,
  preferredFormats: [...LESSON_QUESTION_FORMATS],
  coachingStyle: "gentle",
};

function validFormats(value: unknown): QuestionFormat[] {
  if (!Array.isArray(value)) return [...DEFAULT_LEARNING_PROFILE.preferredFormats];
  const allowed = new Set<QuestionFormat>(LESSON_QUESTION_FORMATS);
  const unique = [...new Set(value.filter((format): format is QuestionFormat => typeof format === "string" && allowed.has(format as QuestionFormat)))];
  return unique.length ? unique : [...DEFAULT_LEARNING_PROFILE.preferredFormats];
}

export function normalizeLearningProfile(value?: Partial<LearningProfile> | null): LearningProfile {
  const dailyGoal = typeof value?.dailyQuestionGoal === "number" ? Math.round(value.dailyQuestionGoal) : DEFAULT_LEARNING_PROFILE.dailyQuestionGoal;
  const questionCount = typeof value?.lessonQuestionCount === "number" ? Math.round(value.lessonQuestionCount) : DEFAULT_LEARNING_PROFILE.lessonQuestionCount;
  return {
    ...DEFAULT_LEARNING_PROFILE,
    ...value,
    targetLanguage: canonicalLanguageName(value?.targetLanguage, DEFAULT_LEARNING_PROFILE.targetLanguage),
    sourceLanguage: normalizeSourceLanguage(value?.sourceLanguage),
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
