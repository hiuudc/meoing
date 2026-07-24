import { QUESTION_FORMAT_REGISTRY } from "./questionRegistry";
import {
  LESSON_QUESTION_FORMATS,
  QUESTION_FORMATS,
  type CustomQuestionTemplate,
  type LearningProfile,
  type Lesson,
  type QuestionFormat,
  type QuestionPresentationSettings,
  type UnitQuestionSettings,
} from "./types";

export const MAX_CUSTOM_QUESTION_TEMPLATES = 20;
export const MAX_CUSTOM_TEMPLATE_NAME_LENGTH = 80;
export const MAX_CUSTOM_TEMPLATE_GUIDANCE_LENGTH = 2_000;
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

export function normalizeQuestionPresentation(
  value: unknown,
  fallback: QuestionPresentationSettings = { readQuestion: false, readAnswers: false, wordTooltips: true },
): QuestionPresentationSettings {
  const source = isRecord(value) ? value : {};
  return {
    readQuestion: typeof source.readQuestion === "boolean" ? source.readQuestion : fallback.readQuestion,
    readAnswers: typeof source.readAnswers === "boolean" ? source.readAnswers : fallback.readAnswers,
    wordTooltips: typeof source.wordTooltips === "boolean" ? source.wordTooltips : fallback.wordTooltips,
  };
}

function normalizeTemplate(value: unknown, index: number, usedIds: Set<string>): CustomQuestionTemplate | null {
  if (!isRecord(value)) return null;
  const rawId = typeof value.id === "string" ? value.id.trim().slice(0, 120) : "";
  let id = rawId || `custom-question-${index + 1}`;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${rawId || `custom-question-${index + 1}`}-${suffix}`.slice(0, 120);
    suffix += 1;
  }
  usedIds.add(id);

  const baseFormat = isLessonQuestionFormat(value.baseFormat) ? value.baseFormat : "singleChoice";
  const name = typeof value.name === "string" ? value.name.trim().slice(0, MAX_CUSTOM_TEMPLATE_NAME_LENGTH) : "";
  const guidance = typeof value.guidance === "string"
    ? value.guidance.trim().slice(0, MAX_CUSTOM_TEMPLATE_GUIDANCE_LENGTH)
    : "";

  return {
    id,
    name: name || `Custom question ${index + 1}`,
    baseFormat,
    guidance,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    presentation: normalizeQuestionPresentation(value.presentation, defaultPresentationForFormat(baseFormat)),
  };
}

export function normalizeUnitQuestionSettings(value: unknown): UnitQuestionSettings {
  const source = isRecord(value) ? value : {};
  const rawFormats = Array.isArray(source.enabledFormats) ? source.enabledFormats : [];
  const enabledFormats = [...new Set(rawFormats.filter(isLessonQuestionFormat))];
  const formatPresentationSource = isRecord(source.formatPresentation) ? source.formatPresentation : {};
  const formatPresentation: UnitQuestionSettings["formatPresentation"] = {};

  QUESTION_FORMATS.forEach((format) => {
    formatPresentation[format] = normalizeQuestionPresentation(
      formatPresentationSource[format],
      defaultPresentationForFormat(format),
    );
  });

  const usedIds = new Set<string>();
  const customTemplates = (Array.isArray(source.customTemplates) ? source.customTemplates : [])
    .slice(0, MAX_CUSTOM_QUESTION_TEMPLATES)
    .map((template, index) => normalizeTemplate(template, index, usedIds))
    .filter((template): template is CustomQuestionTemplate => template !== null);

  return {
    enabledFormats: enabledFormats.length ? enabledFormats : [...LESSON_QUESTION_FORMATS],
    formatPresentation,
    customTemplates,
    characterTracing: {
      requireStrokeOrder: !isRecord(source.characterTracing)
        || typeof source.characterTracing.requireStrokeOrder !== "boolean"
        ? true
        : source.characterTracing.requireStrokeOrder,
    },
  };
}

export function getEffectiveUnitQuestionSettings(
  settings: UnitQuestionSettings | undefined,
  profile: LearningProfile,
): UnitQuestionSettings {
  const normalized = settings ? normalizeUnitQuestionSettings(settings) : normalizeUnitQuestionSettings({
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
    formatPresentation: normalized.formatPresentation,
    customTemplates: normalized.customTemplates.map((template) => ({
      ...template,
      presentation: { ...template.presentation },
      enabled: template.enabled
        && isLessonQuestionFormat(template.baseFormat)
        && (speakingAllowed || !isSpeakingQuestionFormat(template.baseFormat))
        && supportsQuestionFormatForLanguage(template.baseFormat, profile.targetLanguage),
    })),
    characterTracing: { ...normalized.characterTracing },
  };
}

export function validateUnitQuestionSettings(
  settings: UnitQuestionSettings,
  profile: LearningProfile,
  questionCount = profile.lessonQuestionCount,
): string[] {
  const errors: string[] = [];
  const effective = getEffectiveUnitQuestionSettings(settings, profile);
  const enabledFormats = effective.enabledFormats;
  const enabledFormatSet = new Set(enabledFormats);

  if (enabledFormats.length < 5) errors.push("Enable at least five question formats.");
  if (!enabledFormats.some((format) => !isAiGradedQuestionFormat(format))) {
    errors.push("Enable at least one locally graded format.");
  }
  if (!enabledFormats.some(isAiGradedQuestionFormat)) {
    errors.push("Enable at least one AI-graded format.");
  }
  if (settings.customTemplates.length > MAX_CUSTOM_QUESTION_TEMPLATES) {
    errors.push(`A unit can contain at most ${MAX_CUSTOM_QUESTION_TEMPLATES} custom blueprints.`);
  }

  const templateIds = new Set<string>();
  settings.customTemplates.forEach((template, index) => {
    if (!template.id.trim() || templateIds.has(template.id)) errors.push(`Blueprint ${index + 1} needs a unique ID.`);
    templateIds.add(template.id);
    if (!template.name.trim()) errors.push(`Blueprint ${index + 1} needs a name.`);
    if (template.name.length > MAX_CUSTOM_TEMPLATE_NAME_LENGTH) {
      errors.push(`Blueprint names cannot exceed ${MAX_CUSTOM_TEMPLATE_NAME_LENGTH} characters.`);
    }
    if (template.guidance.length > MAX_CUSTOM_TEMPLATE_GUIDANCE_LENGTH) {
      errors.push(`Blueprint guidance cannot exceed ${MAX_CUSTOM_TEMPLATE_GUIDANCE_LENGTH.toLocaleString()} characters.`);
    }
  });

  const enabledTemplates = effective.customTemplates.filter((template) => template.enabled);
  if (enabledTemplates.length > questionCount) {
    errors.push(`Only ${questionCount} questions are available, but ${enabledTemplates.length} enabled blueprints are required.`);
  }
  enabledTemplates.forEach((template) => {
    if (!enabledFormatSet.has(template.baseFormat)) {
      errors.push(`Enable ${QUESTION_FORMAT_REGISTRY[template.baseFormat].label} to use the blueprint "${template.name}".`);
    }
  });

  const requiredFormats = new Set(enabledTemplates.map((template) => template.baseFormat));
  const remainingSlots = Math.max(0, questionCount - enabledTemplates.length);
  const additionalFormats = enabledFormats.filter((format) => !requiredFormats.has(format)).length;
  const possibleDistinctFormats = requiredFormats.size + Math.min(remainingSlots, additionalFormats);
  if (possibleDistinctFormats < 5) {
    errors.push("Enabled blueprints leave too few lesson slots to use five distinct formats.");
  }

  return [...new Set(errors)];
}

export interface QuestionGenerationConstraints {
  allowedFormats: QuestionFormat[];
  requiredTemplates: Array<{ id: string; format: QuestionFormat }>;
}

export function buildQuestionGenerationConstraints(
  settings: UnitQuestionSettings | undefined,
  profile: LearningProfile,
): QuestionGenerationConstraints {
  const effective = getEffectiveUnitQuestionSettings(settings, profile);
  return {
    allowedFormats: [...effective.enabledFormats],
    requiredTemplates: effective.customTemplates
      .filter((template) => template.enabled)
      .map((template) => ({ id: template.id, format: template.baseFormat })),
  };
}

export function decorateLessonPresentation(
  lesson: Lesson,
  settings: UnitQuestionSettings | undefined,
  profile: LearningProfile,
): Lesson {
  const effective = getEffectiveUnitQuestionSettings(settings, profile);
  const templates = new Map(effective.customTemplates.map((template) => [template.id, template]));
  const decorateQuestion = (question: Lesson["questions"][number]) => {
    const template = question.templateId ? templates.get(question.templateId) : undefined;
    const presentationSettings = template?.baseFormat === question.type
      ? template.presentation
      : effective.formatPresentation[question.type] ?? defaultPresentationForFormat(question.type);
    return {
      ...question,
      ...(question.type === "characterTracing"
        ? { requireStrokeOrder: effective.characterTracing.requireStrokeOrder }
        : {}),
      presentation: { ...presentationSettings },
    };
  };
  return {
    ...lesson,
    schemaVersion: lesson.schemaVersion >= 3 ? lesson.schemaVersion : 2,
    questions: lesson.questions.map(decorateQuestion),
    questionAlternates: lesson.questionAlternates?.map((alternate) => ({
      ...alternate,
      question: decorateQuestion(alternate.question),
    })),
  };
}
