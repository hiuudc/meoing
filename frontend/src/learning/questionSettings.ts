import { QUESTION_FORMAT_REGISTRY } from "./questionRegistry";
import {
  LESSON_QUESTION_FORMATS,
  QUESTION_FORMATS,
  type CollectionQuestionSettings,
  type LearningProfile,
  type Lesson,
  type LessonQuestionFormat,
  type QuestionFormat,
  type QuestionPresentationSettings,
} from "./types";

export const LISTENING_QUESTION_FORMATS = [
  "dictation",
  "listenSelect",
  "audioMatching",
  "soundDiscrimination",
] as const satisfies readonly QuestionFormat[];
export const WRITTEN_ANSWER_FORMATS = [
  "fillBlank",
  "multiCloze",
  "translation",
  "shortAnswer",
  "errorCorrection",
  "sentenceTransformation",
  "dictation",
  "freeWriting",
] as const satisfies readonly QuestionFormat[];

const formatSet = new Set<string>(QUESTION_FORMATS);
const lessonFormatSet = new Set<string>(LESSON_QUESTION_FORMATS);
const listeningFormatSet = new Set<QuestionFormat>(LISTENING_QUESTION_FORMATS);
const writtenAnswerFormatSet = new Set<QuestionFormat>(WRITTEN_ANSWER_FORMATS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isQuestionFormat(value: unknown): value is QuestionFormat {
  return typeof value === "string" && formatSet.has(value);
}

export function isLessonQuestionFormat(value: unknown): value is Exclude<QuestionFormat, "characterTracing"> {
  return typeof value === "string" && lessonFormatSet.has(value);
}

export function isSpeakingQuestionFormat(format: QuestionFormat): boolean {
  return QUESTION_FORMAT_REGISTRY[format].badge === "speaking";
}

export function isListeningQuestionFormat(format: QuestionFormat): boolean {
  return listeningFormatSet.has(format);
}

export function isWrittenAnswerFormat(format: QuestionFormat): boolean {
  return writtenAnswerFormatSet.has(format);
}

export function supportsQuestionFormatForLanguage(format: QuestionFormat, targetLanguage: string): boolean {
  if (format !== "characterTracing") return true;
  return ["chinese", "japanese", "korean"].includes(targetLanguage.trim().toLocaleLowerCase());
}

export function isAiGradedQuestionFormat(format: QuestionFormat): boolean {
  return QUESTION_FORMAT_REGISTRY[format].evaluationMode === "ai";
}

export function defaultPresentationForFormat(format: QuestionFormat): QuestionPresentationSettings {
  return {
    readQuestion: isListeningQuestionFormat(format) || format === "speakingRepeat",
    readAnswers: false,
    wordTooltips: true,
  };
}

export function normalizeCollectionQuestionSettings(value: unknown): CollectionQuestionSettings {
  const source = isRecord(value) ? value : {};
  const rawFormats = Array.isArray(source.enabledFormats) ? source.enabledFormats : [];
  const enabledFormats = [...new Set(rawFormats.filter(isLessonQuestionFormat))];

  return {
    enabledFormats: enabledFormats.length ? enabledFormats : [...LESSON_QUESTION_FORMATS],
    characterTracing: {
      requireStrokeOrder: !isRecord(source.characterTracing)
        || typeof source.characterTracing.requireStrokeOrder !== "boolean"
        ? true
        : source.characterTracing.requireStrokeOrder,
    },
  };
}

export function getEffectiveCollectionQuestionSettings(
  settings: CollectionQuestionSettings | undefined,
  profile: LearningProfile,
): CollectionQuestionSettings {
  const normalized = settings ? normalizeCollectionQuestionSettings(settings) : normalizeCollectionQuestionSettings({
    enabledFormats: [...new Set([
      ...profile.preferredFormats,
      "selectBlank" as const,
      "listenSelect" as const,
      "audioMatching" as const,
      "soundDiscrimination" as const,
      "flashcardRecall" as const,
    ])],
  });
  const speakingAllowed = profile.speakingEnabled;
  return {
    enabledFormats: normalized.enabledFormats.filter((format) => (
      isLessonQuestionFormat(format)
      &&
      (speakingAllowed || !isSpeakingQuestionFormat(format))
      && supportsQuestionFormatForLanguage(format, profile.targetLanguage)
    )),
    characterTracing: { ...normalized.characterTracing },
  };
}

export function validateCollectionQuestionSettings(
  settings: CollectionQuestionSettings,
  profile: LearningProfile,
  questionCount = profile.lessonQuestionCount,
): string[] {
  const errors: string[] = [];
  const effective = getEffectiveCollectionQuestionSettings(settings, profile);
  const enabledFormats = effective.enabledFormats.filter(isLessonQuestionFormat);

  if (enabledFormats.length < 5) errors.push("Enable at least five question formats.");
  if (!enabledFormats.some((format) => !isAiGradedQuestionFormat(format))) {
    errors.push("Enable at least one locally graded format.");
  }
  if (!enabledFormats.some(isAiGradedQuestionFormat)) {
    errors.push("Enable at least one AI-graded format.");
  }
  if (questionCount < 5) errors.push("Lesson size must leave room for five distinct formats.");

  return [...new Set(errors)];
}

export interface QuestionGenerationConstraints {
  allowedFormats: LessonQuestionFormat[];
}

export function buildQuestionGenerationConstraints(
  settings: CollectionQuestionSettings | undefined,
  profile: LearningProfile,
): QuestionGenerationConstraints {
  const effective = getEffectiveCollectionQuestionSettings(settings, profile);
  return {
    allowedFormats: effective.enabledFormats.filter(isLessonQuestionFormat),
  };
}

export function decorateLessonPresentation(
  lesson: Lesson,
  settings: CollectionQuestionSettings | undefined,
  profile: LearningProfile,
): Lesson {
  const decorateQuestion = (question: Lesson["questions"][number]) => {
    return {
      ...question,
      presentation: defaultPresentationForFormat(question.type),
    };
  };
  return {
    ...lesson,
    schemaVersion: 8,
    questions: lesson.questions.map(decorateQuestion),
    questionAlternates: lesson.questionAlternates.map((alternate) => ({
      ...alternate,
      question: decorateQuestion(alternate.question),
    })),
  };
}
