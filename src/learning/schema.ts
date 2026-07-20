import { z } from "zod";
import {
  QUESTION_FORMATS,
  type Evaluation,
  type LearningProfile,
  type Lesson,
  type LessonProgressSnapshot,
} from "./types";

const id = z.string().min(1).max(120);
const plainText = z.string().min(1).max(16_000);
const optionSchema = z.object({ id, label: plainText.max(500) }).strict();
const textMatchSchema = z
  .object({
    caseSensitive: z.boolean().optional(),
    ignoreDiacritics: z.boolean().optional(),
    ignorePunctuation: z.boolean().optional(),
  })
  .strict();

const baseFields = {
  id,
  prompt: plainText,
  explanation: plainText,
  hint: plainText.optional(),
  supplementalHint: plainText.optional(),
  sourceReferenceIds: z.array(id).max(20).optional(),
  evaluationMode: z.enum(["local", "ai"]),
};

export const lessonQuestionSchema = z.discriminatedUnion("type", [
  z.object({ ...baseFields, type: z.literal("singleChoice"), options: z.array(optionSchema).min(2).max(10), correctOptionId: id }).strict(),
  z.object({ ...baseFields, type: z.literal("multipleChoice"), options: z.array(optionSchema).min(2).max(12), correctOptionIds: z.array(id).min(1).max(12) }).strict(),
  z.object({ ...baseFields, type: z.literal("trueFalse"), statement: plainText, correct: z.boolean() }).strict(),
  z.object({ ...baseFields, type: z.literal("fillBlank"), template: plainText, acceptedAnswers: z.array(plainText.max(500)).min(1).max(20), match: textMatchSchema.optional() }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("multiCloze"),
    template: plainText,
    blanks: z.array(z.object({ id, acceptedAnswers: z.array(plainText.max(500)).min(1).max(20) }).strict()).min(2).max(12),
    match: textMatchSchema.optional(),
  }).strict(),
  z.object({ ...baseFields, type: z.literal("wordBank"), tokens: z.array(optionSchema).min(2).max(30), correctOrderIds: z.array(id).min(1).max(30) }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("matching"),
    pairs: z.array(z.object({ leftId: id, left: plainText.max(500), rightId: id, right: plainText.max(500) }).strict()).min(2).max(12),
  }).strict(),
  z.object({ ...baseFields, type: z.literal("reorderTokens"), tokens: z.array(optionSchema).min(2).max(30), correctOrderIds: z.array(id).min(2).max(30) }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("reorderDialogue"),
    turns: z.array(optionSchema.extend({ speaker: plainText.max(120) }).strict()).min(2).max(20),
    correctOrderIds: z.array(id).min(2).max(20),
  }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("categorize"),
    categories: z.array(optionSchema).min(2).max(10),
    items: z.array(optionSchema.extend({ categoryId: id }).strict()).min(2).max(30),
  }).strict(),
  z.object({ ...baseFields, type: z.literal("translation"), sourceText: plainText, targetLanguage: plainText.max(100), referenceAnswer: plainText, rubric: z.array(plainText.max(500)).min(1).max(10) }).strict(),
  z.object({ ...baseFields, type: z.literal("shortAnswer"), referenceAnswer: plainText, requiredIdeas: z.array(plainText.max(500)).min(1).max(12), rubric: z.array(plainText.max(500)).min(1).max(10) }).strict(),
  z.object({ ...baseFields, type: z.literal("errorCorrection"), incorrectText: plainText, acceptedAnswers: z.array(plainText).min(1).max(20), match: textMatchSchema.optional() }).strict(),
  z.object({ ...baseFields, type: z.literal("sentenceTransformation"), sourceText: plainText, constraint: plainText, acceptedAnswers: z.array(plainText).min(1).max(20), match: textMatchSchema.optional() }).strict(),
  z.object({ ...baseFields, type: z.literal("dictation"), transcript: plainText, acceptedAnswers: z.array(plainText).min(1).max(20), match: textMatchSchema.optional() }).strict(),
  z.object({ ...baseFields, type: z.literal("freeWriting"), minWords: z.number().int().min(1).max(1_000), maxWords: z.number().int().min(1).max(2_000), rubric: z.array(plainText.max(500)).min(1).max(12) }).strict(),
  z.object({ ...baseFields, type: z.literal("speakingRepeat"), modelText: plainText, rubric: z.array(plainText.max(500)).min(1).max(12) }).strict(),
  z.object({ ...baseFields, type: z.literal("speakingRoleplay"), role: plainText.max(500), scenario: plainText, goal: plainText, rubric: z.array(plainText.max(500)).min(1).max(12) }).strict(),
]);

export const lessonSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    unitId: id,
    title: plainText.max(300),
    summary: plainText.max(2_000),
    targetLanguage: plainText.max(100),
    level: z.enum(["beginner", "elementary", "intermediate", "upperIntermediate", "advanced"]),
    objectives: z.array(plainText.max(500)).min(1).max(12),
    theory: z.array(z.object({ id, kind: z.enum(["concept", "grammar", "pronunciation", "culture", "tip"]), title: plainText.max(300), body: plainText }).strict()).min(1).max(20),
    examples: z.array(z.object({ id, source: plainText, translation: plainText.optional(), note: plainText.optional() }).strict()).max(30),
    glossary: z.array(z.object({ term: plainText.max(300), meaning: plainText.max(1_000), example: plainText.optional() }).strict()).max(80),
    sourceReferences: z.array(z.object({ id, kind: z.enum(["unit", "document", "youtube", "transcript", "note"]), title: plainText.max(500), url: z.string().url().max(2_000).optional(), excerpt: plainText.max(2_000).optional() }).strict()).max(50),
    questions: z.array(lessonQuestionSchema).min(8).max(15),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((lesson, context) => {
    const formats = new Set(lesson.questions.map((question) => question.type));
    if (formats.size < 5) {
      context.addIssue({ code: "custom", path: ["questions"], message: "A lesson must contain at least five question formats." });
    }
    const questionIds = new Set<string>();
    lesson.questions.forEach((question, index) => {
      if (questionIds.has(question.id)) {
        context.addIssue({ code: "custom", path: ["questions", index, "id"], message: "Question IDs must be unique." });
      }
      questionIds.add(question.id);
    });
  });

export function parseLesson(value: unknown): Lesson {
  return lessonSchema.parse(value) as Lesson;
}

const evaluationText = z.string().max(8_192);

export const evaluationSchema = z
  .object({
    status: z.enum(["correct", "partial", "incorrect"]),
    score: z.number().min(0).max(1),
    correctParts: z.array(evaluationText).max(100),
    errors: z.array(z.object({ location: z.string().max(500), message: evaluationText }).strict()).max(100),
    correction: evaluationText,
    explanation: evaluationText,
    nextHint: evaluationText,
    rubricScores: z.array(z.object({ criterion: z.string().max(500), score: z.number().min(0).max(1), note: evaluationText }).strict()).max(20).optional(),
    pronunciationAssessed: z.boolean().optional(),
  })
  .strict();

export function parseEvaluation(value: unknown): Evaluation {
  return evaluationSchema.parse(value) as Evaluation;
}

export const lessonProgressSnapshotSchema = z
  .object({
    lessonId: id,
    completedQuestionIds: z.array(id).max(15),
    attemptsByQuestion: z.record(id, z.number().int().min(0).max(100)),
    firstTryCorrect: z.number().int().min(0).max(15),
    totalQuestions: z.number().int().min(8).max(15),
    masteryPercent: z.number().min(0).max(100),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.completedQuestionIds.length > snapshot.totalQuestions) {
      context.addIssue({
        code: "custom",
        path: ["completedQuestionIds"],
        message: "Completed question count cannot exceed total questions.",
      });
    }
    if (snapshot.firstTryCorrect > snapshot.totalQuestions) {
      context.addIssue({
        code: "custom",
        path: ["firstTryCorrect"],
        message: "First-try correct count cannot exceed total questions.",
      });
    }
    if (Object.keys(snapshot.attemptsByQuestion).length > snapshot.totalQuestions) {
      context.addIssue({
        code: "custom",
        path: ["attemptsByQuestion"],
        message: "Attempt count cannot contain more questions than the lesson.",
      });
    }
  });

export function parseLessonProgressSnapshot(value: unknown): LessonProgressSnapshot {
  return lessonProgressSnapshotSchema.parse(value) as LessonProgressSnapshot;
}

export function validateLessonForProfile(lesson: Lesson, profile: LearningProfile): string[] {
  const errors: string[] = [];
  if (lesson.questions.length < 8 || lesson.questions.length > 15) errors.push("Lesson must have 8-15 questions.");
  if (new Set(lesson.questions.map((question) => question.type)).size < 5) errors.push("Lesson must use at least five formats.");
  if (profile.speakingEnabled && !lesson.questions.some((question) => question.type === "speakingRepeat" || question.type === "speakingRoleplay")) {
    errors.push("Speaking is enabled, so the lesson needs at least one speaking question.");
  }
  if (lesson.questions.some((question) => !QUESTION_FORMATS.includes(question.type))) errors.push("Lesson contains an unsupported question format.");
  return errors;
}

export interface LessonExpectation {
  unitId: string;
  targetLanguage: string;
  level: LearningProfile["level"];
  questionCount: number;
  speaking: boolean;
}

export function validateLessonForExpectation(lesson: Lesson, expectation: LessonExpectation): string[] {
  const errors: string[] = [];
  if (new Set(lesson.questions.map((question) => question.type)).size < 5) {
    errors.push("Lesson must use at least five formats.");
  }
  if (expectation.speaking && !lesson.questions.some((question) => question.type === "speakingRepeat" || question.type === "speakingRoleplay")) {
    errors.push("Speaking is enabled, so the lesson needs at least one speaking question.");
  }
  if (lesson.questions.some((question) => !QUESTION_FORMATS.includes(question.type))) {
    errors.push("Lesson contains an unsupported question format.");
  }
  if (lesson.unitId !== expectation.unitId) errors.push(`lesson.unitId must equal ${expectation.unitId}.`);
  if (lesson.targetLanguage.trim().toLocaleLowerCase() !== expectation.targetLanguage.trim().toLocaleLowerCase()) {
    errors.push(`lesson.targetLanguage must equal ${expectation.targetLanguage}.`);
  }
  if (lesson.level !== expectation.level) errors.push(`lesson.level must equal ${expectation.level}.`);
  if (lesson.questions.length !== expectation.questionCount) {
    errors.push(`lesson.questions must contain exactly ${expectation.questionCount} items.`);
  }
  const evaluationModes = new Set(lesson.questions.map((question) => question.evaluationMode));
  if (!evaluationModes.has("local")) errors.push("Lesson must include at least one locally graded question.");
  if (!evaluationModes.has("ai")) errors.push("Lesson must include at least one AI-graded question.");
  return errors;
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
