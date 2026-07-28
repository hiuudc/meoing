import { z } from "zod";
import {
  LESSON_QUESTION_FORMATS,
  type Evaluation,
  type LearningProfile,
  type Lesson,
  type LessonQuestionFormat,
  type LessonProgressSnapshot,
} from "./types";
import { QUESTION_FORMAT_REGISTRY } from "./questionRegistry";
import {
  isListeningQuestionFormat,
  isWrittenAnswerFormat,
  supportsQuestionFormatForLanguage,
} from "./questionSettings";
import { segmentGlossaryText } from "./glossary";
import { questionVisibleTexts } from "./questionContent";
import { stripBlankMarkers, validateMultiClozeMarkers } from "./multiCloze";

const id = z.string().min(1).max(120);
const plainText = z.string().min(1).max(16_000);
const optionSchema = z.object({ id, label: plainText.max(500) }).strict();
const answerBankSchema = z
  .object({
    tokens: z.array(optionSchema).min(2).max(30),
    separator: z.enum(["space", "none"]),
    defaultMode: z.enum(["keyboard", "bank"]),
  })
  .strict();
const textMatchSchema = z
  .object({
    caseSensitive: z.boolean().optional(),
    ignoreDiacritics: z.boolean().optional(),
    ignorePunctuation: z.boolean().optional(),
  })
  .strict();
const presentationSchema = z
  .object({
    readQuestion: z.boolean(),
    readAnswers: z.boolean(),
    wordTooltips: z.boolean(),
  })
  .strict();
const pronunciationSchema = z
  .object({ native: plainText.max(300).optional(), romanized: plainText.max(300).optional() })
  .strict()
  .refine((value) => Boolean(value.native || value.romanized), "Pronunciation needs a native or romanized value.");
const glossaryEntrySchema = z.object({
  term: plainText.max(300),
  meaning: plainText.max(1_000),
  otherMeanings: z.array(plainText.max(1_000)).max(8).optional(),
  forms: z.array(plainText.max(300)).max(20).optional(),
  aliases: z.array(plainText.max(300)).max(20).optional(),
  pronunciation: pronunciationSchema.optional(),
  example: plainText.optional(),
}).strict();

const sentenceEndingPunctuation = /[.!?。！？…]+$/u;

function normalizeBankComposition(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function answerBankCanCompose(
  referenceAnswer: string,
  tokens: ReadonlyArray<{ id: string; label: string }>,
  minimumTokenCount = 1,
): boolean {
  const target = normalizeBankComposition(referenceAnswer);
  if (!target) return false;
  const parts = tokens
    .map((token, index) => ({
      id: `${index}:${token.id}`,
      text: normalizeBankComposition(token.label),
    }))
    .filter((token) => token.text);
  const failed = new Set<string>();

  function visit(offset: number, used: Set<string>, count: number): boolean {
    if (offset === target.length) return count >= minimumTokenCount;
    const key = `${offset}|${count}|${[...used].sort().join(",")}`;
    if (failed.has(key)) return false;
    for (const token of parts) {
      if (used.has(token.id) || !target.startsWith(token.text, offset)) continue;
      const nextUsed = new Set(used);
      nextUsed.add(token.id);
      if (visit(offset + token.text.length, nextUsed, count + 1)) return true;
    }
    failed.add(key);
    return false;
  }

  return visit(0, new Set(), 0);
}

function hasWholeReferenceToken(
  referenceAnswer: string,
  tokens: ReadonlyArray<{ label: string }>,
): boolean {
  const reference = normalizeBankComposition(referenceAnswer);
  return tokens.some((token) => normalizeBankComposition(token.label) === reference);
}

function whitespaceLexicalUnitCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function needsSentenceBankComposition(value: string, lexicalUnitCount = whitespaceLexicalUnitCount(value)): boolean {
  return sentenceEndingPunctuation.test(value.trim()) || lexicalUnitCount > 2;
}

function expectedSentenceBankAnswers(question: {
  type: string;
  referenceAnswer?: string;
  acceptedAnswers?: string[];
}): string[] {
  if (question.type === "translation" || question.type === "shortAnswer") {
    return question.referenceAnswer ? [question.referenceAnswer] : [];
  }
  if (
    question.type === "errorCorrection"
    || question.type === "sentenceTransformation"
    || question.type === "dictation"
  ) {
    return question.acceptedAnswers ?? [];
  }
  return [];
}

function isDeclaredBlankAnswerToken(
  question: {
    type: string;
    acceptedAnswers?: string[];
    blanks?: Array<{ acceptedAnswers: string[] }>;
  },
  label: string,
): boolean {
  const normalizedLabel = normalizeBankComposition(label);
  if (!normalizedLabel) return false;
  if (question.type === "fillBlank") {
    return question.acceptedAnswers?.some(
      (answer) => normalizeBankComposition(answer) === normalizedLabel,
    ) ?? false;
  }
  if (question.type === "multiCloze") {
    return question.blanks?.some((blank) => blank.acceptedAnswers.some(
      (answer) => normalizeBankComposition(answer) === normalizedLabel,
    )) ?? false;
  }
  return false;
}

const baseFields = {
  id,
  prompt: plainText,
  targetPrompt: plainText.optional(),
  explanation: plainText,
  hint: plainText.optional(),
  supplementalHint: plainText.optional(),
  sourceReferenceIds: z.array(id).max(20).optional(),
  evaluationMode: z.enum(["local", "ai"]),
  presentation: presentationSchema.optional(),
  glossaryTargets: z.array(plainText.max(2_000)).max(80).optional(),
  answerBank: answerBankSchema.optional(),
};

export const lessonQuestionSchema = z.discriminatedUnion("type", [
  z.object({ ...baseFields, type: z.literal("singleChoice"), options: z.array(optionSchema).min(2).max(10), correctOptionId: id }).strict(),
  z.object({ ...baseFields, type: z.literal("multipleChoice"), options: z.array(optionSchema).min(2).max(12), correctOptionIds: z.array(id).min(1).max(12) }).strict(),
  z.object({ ...baseFields, type: z.literal("trueFalse"), statement: plainText, correct: z.boolean() }).strict(),
  z.object({ ...baseFields, type: z.literal("fillBlank"), template: plainText, acceptedAnswers: z.array(plainText.max(500)).min(1).max(20), match: textMatchSchema.optional() }).strict(),
  z.object({ ...baseFields, type: z.literal("selectBlank"), template: plainText, options: z.array(optionSchema).min(2).max(8), correctOptionId: id }).strict(),
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
  z.object({
    ...baseFields,
    type: z.literal("freeWriting"),
    minWords: z.number().int().min(1).max(1_000),
    maxWords: z.number().int().min(1).max(2_000),
    rubric: z.array(plainText.max(500)).min(1).max(12),
    supportBank: z.array(optionSchema).min(8).max(30).optional(),
    supportBankSeparator: z.enum(["space", "none"]).optional(),
  }).strict(),
  z.object({ ...baseFields, type: z.literal("speakingRepeat"), modelText: plainText, rubric: z.array(plainText.max(500)).min(1).max(12) }).strict(),
  z.object({ ...baseFields, type: z.literal("speakingRoleplay"), role: plainText.max(500), scenario: plainText, goal: plainText, rubric: z.array(plainText.max(500)).min(1).max(12) }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("listenSelect"),
    audioText: plainText,
    options: z.array(optionSchema).min(2).max(8),
    correctOptionId: id,
  }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("audioMatching"),
    pairs: z.array(z.object({
      audioId: id,
      audioText: plainText.max(500),
      matchId: id,
      label: plainText.max(500),
    }).strict()).min(2).max(8),
  }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("soundDiscrimination"),
    audioText: plainText,
    options: z.array(optionSchema).min(2).max(8),
    correctOptionId: id,
  }).strict(),
  z.object({
    ...baseFields,
    type: z.literal("flashcardRecall"),
    cue: plainText,
    acceptedAnswers: z.array(plainText.max(500)).min(1).max(20),
    match: textMatchSchema.optional(),
  }).strict(),
]).superRefine((question, context) => {
  if (question.answerBank) {
    const tokenIds = new Set(question.answerBank.tokens.map((token) => token.id));
    if (tokenIds.size !== question.answerBank.tokens.length) {
      context.addIssue({ code: "custom", path: ["answerBank", "tokens"], message: "Answer-bank token IDs must be unique." });
    }
    if (!isWrittenAnswerFormat(question.type)) {
      context.addIssue({ code: "custom", path: ["answerBank"], message: `${question.type} cannot define an answer bank.` });
    } else {
      const expectedMode = question.type === "shortAnswer" || question.type === "freeWriting" ? "keyboard" : "bank";
      if (question.answerBank.defaultMode !== expectedMode) {
        context.addIssue({
          code: "custom",
          path: ["answerBank", "defaultMode"],
          message: `${question.type} answerBank.defaultMode must be ${expectedMode}.`,
        });
      }
    }
    question.answerBank.tokens.forEach((token, index) => {
      if (sentenceEndingPunctuation.test(token.label.trim())) {
        context.addIssue({
          code: "custom",
          path: ["answerBank", "tokens", index, "label"],
          message: "Answer-bank tokens must not include sentence-ending punctuation.",
        });
      }
      if (
        whitespaceLexicalUnitCount(token.label) > 2
        && !isDeclaredBlankAnswerToken(question, token.label)
      ) {
        context.addIssue({
          code: "custom",
          path: ["answerBank", "tokens", index, "label"],
          message: "Answer-bank tokens must contain at most two lexical units.",
        });
      }
    });
    const sentenceAnswers = expectedSentenceBankAnswers(question)
      .filter((answer) => needsSentenceBankComposition(answer));
    if (sentenceAnswers.some((answer) => hasWholeReferenceToken(answer, question.answerBank!.tokens))) {
      context.addIssue({
        code: "custom",
        path: ["answerBank", "tokens"],
        message: `${question.type} answer banks cannot contain a complete sentence answer in one token.`,
      });
    }
    if (
      sentenceAnswers.length
      && !sentenceAnswers.some((answer) => answerBankCanCompose(answer, question.answerBank!.tokens, 2))
    ) {
      context.addIssue({
        code: "custom",
        path: ["answerBank", "tokens"],
        message: `${question.type} answer-bank tokens must compose at least one complete answer exactly in the same order.`,
      });
    }
  }
  if (question.type === "selectBlank") {
    const blankCount = question.template.split("{{blank}}").length - 1;
    if (blankCount !== 1) {
      context.addIssue({ code: "custom", path: ["template"], message: "selectBlank requires exactly one {{blank}} marker." });
    }
  }
  if (question.type === "fillBlank") {
    const markers = question.template.match(/\{\{blank(?::[^{}]+)?\}\}/g) ?? [];
    if (markers.length !== 1 || question.template.includes("___")) {
      context.addIssue({
        code: "custom",
        path: ["template"],
        message: "fillBlank requires exactly one {{blank}} or {{blank:<id>}} marker.",
      });
    }
  }
  if (question.type === "selectBlank" || question.type === "listenSelect" || question.type === "soundDiscrimination") {
    const optionIds = new Set(question.options.map((option) => option.id));
    if (optionIds.size !== question.options.length) {
      context.addIssue({ code: "custom", path: ["options"], message: `${question.type} option IDs must be unique.` });
    }
    if (!optionIds.has(question.correctOptionId)) {
      context.addIssue({ code: "custom", path: ["correctOptionId"], message: `${question.type} correctOptionId must reference an option.` });
    }
  }
  if (question.type === "audioMatching") {
    const audioIds = new Set(question.pairs.map((pair) => pair.audioId));
    const matchIds = new Set(question.pairs.map((pair) => pair.matchId));
    if (audioIds.size !== question.pairs.length || matchIds.size !== question.pairs.length) {
      context.addIssue({ code: "custom", path: ["pairs"], message: "Audio-matching IDs must be unique." });
    }
  }
});

function targetHasGlossaryCoverage(target: string, glossary: Lesson["glossary"]): boolean {
  return segmentGlossaryText(stripBlankMarkers(target), glossary).every((segment) => (
    Boolean(segment.entry) || !/[\p{L}\p{N}\p{M}]/u.test(segment.text)
  ));
}

function cjkLexicalUnitCount(value: string, glossary: Lesson["glossary"]): number | undefined {
  const segments = segmentGlossaryText(value, glossary, { mode: "lexical-cjk" });
  if (segments.some((segment) => !segment.entry && /[\p{L}\p{N}\p{M}]/u.test(segment.text))) {
    return undefined;
  }
  const count = segments.filter((segment) => (
    segment.entry && /[\p{L}\p{N}\p{M}]/u.test(segment.text)
  )).length;
  return count || undefined;
}

function validateSchemaSevenQuestion(
  question: Lesson["questions"][number],
  lesson: Pick<Lesson, "targetLanguage" | "glossary">,
): string[] {
  const errors: string[] = [];
  if (question.targetPrompt && !targetHasGlossaryCoverage(question.targetPrompt, lesson.glossary)) {
    errors.push(`Question ${question.id} targetPrompt is not fully covered by the glossary.`);
  }
  if (!["Japanese", "Chinese", "Korean"].includes(lesson.targetLanguage)) return errors;
  const missingPronunciation = new Set<string>();
  question.answerBank?.tokens.forEach((token) => {
    const lexicalUnits = cjkLexicalUnitCount(token.label, lesson.glossary);
    if (
      lexicalUnits !== undefined
      && lexicalUnits > 2
      && !isDeclaredBlankAnswerToken(question, token.label)
    ) {
      errors.push(`Answer-bank token ${token.label} must contain at most two CJK lexical units.`);
    }
  });
  const sentenceAnswers = expectedSentenceBankAnswers(question).filter((answer) => {
    const lexicalUnits = cjkLexicalUnitCount(answer, lesson.glossary);
    return needsSentenceBankComposition(answer, lexicalUnits);
  });
  if (
    question.answerBank
    && sentenceAnswers.some((answer) => hasWholeReferenceToken(answer, question.answerBank!.tokens))
  ) {
    errors.push(`Question ${question.id} answer bank cannot contain a complete sentence answer in one token.`);
  }
  if (
    question.answerBank
    && sentenceAnswers.length
    && !sentenceAnswers.some((answer) => answerBankCanCompose(answer, question.answerBank!.tokens, 2))
  ) {
    errors.push(`Question ${question.id} answer bank must compose at least one complete answer exactly in the same order.`);
  }
  (question.glossaryTargets ?? []).forEach((target) => {
    const visibleTarget = stripBlankMarkers(target);
    const lexicalSegments = segmentGlossaryText(visibleTarget, lesson.glossary, { mode: "lexical-cjk" });
    if (
      sentenceEndingPunctuation.test(visibleTarget.trim())
      && (
        lexicalSegments.filter((segment) => segment.entry).length < 2
        || lexicalSegments.some((segment) => !segment.entry && /[\p{L}\p{N}\p{M}]/u.test(segment.text))
      )
    ) {
      errors.push(`CJK glossary target ${target} needs word- and particle-level entries instead of only a whole-sentence entry.`);
    }
    lexicalSegments.forEach((segment) => {
      if (!segment.entry || !/[\p{L}\p{N}\p{M}]/u.test(segment.text)) return;
      if (!segment.entry.pronunciation?.native && !segment.entry.pronunciation?.romanized) {
        missingPronunciation.add(segment.entry.term);
      }
    });
  });
  missingPronunciation.forEach((term) => {
    errors.push(`Target-language glossary term ${term} needs pronunciation metadata.`);
  });
  return errors;
}

export function validateQuestionGlossaryCoverage(
  question: Lesson["questions"][number],
  glossary: Lesson["glossary"],
): string[] {
  if (question.glossaryTargets === undefined) return [`Question ${question.id} needs glossaryTargets.`];
  if (!question.glossaryTargets.length) {
    return question.type === "translation" || question.type === "flashcardRecall"
      ? []
      : [`Question ${question.id} needs at least one glossary target.`];
  }
  const visibleTexts = questionVisibleTexts(question);
  const errors: string[] = [];
  question.glossaryTargets.forEach((target) => {
    if (!visibleTexts.some((text) => text.includes(target))) {
      errors.push(`Question ${question.id} glossary target is not visible: ${target}`);
    } else if (!targetHasGlossaryCoverage(target, glossary)) {
      errors.push(`Question ${question.id} glossary target is not fully covered: ${target}`);
    }
  });
  return errors;
}

export const lessonSchema = z
  .object({
    schemaVersion: z.literal(7),
    id,
    unitId: id,
    title: plainText.max(300),
    summary: plainText.max(2_000),
    targetLanguage: plainText.max(100),
    sourceLanguage: plainText.max(100),
    level: z.enum(["beginner", "elementary", "intermediate", "upperIntermediate", "advanced"]),
    objectives: z.array(plainText.max(500)).min(1).max(12),
    theory: z.array(z.object({ id, kind: z.enum(["concept", "grammar", "pronunciation", "culture", "tip"]), title: plainText.max(300), body: plainText }).strict()).min(1).max(20),
    examples: z.array(z.object({ id, source: plainText, translation: plainText.optional(), note: plainText.optional() }).strict()).max(30),
    glossary: z.array(glossaryEntrySchema).max(160),
    sourceReferences: z.array(z.object({ id, kind: z.enum(["unit", "document", "youtube", "transcript", "note"]), title: plainText.max(500), url: z.string().url().max(2_000).optional(), excerpt: plainText.max(2_000).optional() }).strict()).max(50),
    questions: z.array(lessonQuestionSchema).min(8).max(23),
    questionAlternates: z.array(z.object({ questionId: id, question: lessonQuestionSchema }).strict()).min(8).max(23),
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
      if (question.type === "multiCloze") {
        validateMultiClozeMarkers(question.template, question.blanks.map((blank) => blank.id)).forEach((message) => {
          context.addIssue({ code: "custom", path: ["questions", index, "template"], message });
        });
      }
      validateSchemaSevenQuestion(question, lesson).forEach((message) => {
        context.addIssue({ code: "custom", path: ["questions", index], message });
      });
    });
    const alternateSlotIds = new Set<string>();
    const allQuestionIds = new Set(questionIds);
    lesson.questionAlternates.forEach((alternate, index) => {
      if (!questionIds.has(alternate.questionId)) {
        context.addIssue({ code: "custom", path: ["questionAlternates", index, "questionId"], message: "Alternate must reference a primary question." });
      }
      if (alternateSlotIds.has(alternate.questionId)) {
        context.addIssue({ code: "custom", path: ["questionAlternates", index, "questionId"], message: "Each primary question can have only one alternate." });
      }
      alternateSlotIds.add(alternate.questionId);
      if (allQuestionIds.has(alternate.question.id)) {
        context.addIssue({ code: "custom", path: ["questionAlternates", index, "question", "id"], message: "Primary and alternate question IDs must be unique." });
      }
      allQuestionIds.add(alternate.question.id);
      const primary = lesson.questions.find((question) => question.id === alternate.questionId);
      if (primary?.type === alternate.question.type) {
        context.addIssue({ code: "custom", path: ["questionAlternates", index, "question", "type"], message: "Alternate must use a different format." });
      }
      if (primary && isListeningQuestionFormat(primary.type) && isListeningQuestionFormat(alternate.question.type)) {
        context.addIssue({ code: "custom", path: ["questionAlternates", index, "question", "type"], message: "Listening alternates cannot require listening." });
      }
      if (alternate.question.type === "multiCloze") {
        validateMultiClozeMarkers(
          alternate.question.template,
          alternate.question.blanks.map((blank) => blank.id),
        ).forEach((message) => {
          context.addIssue({ code: "custom", path: ["questionAlternates", index, "question", "template"], message });
        });
      }
      validateSchemaSevenQuestion(alternate.question, lesson).forEach((message) => {
        context.addIssue({ code: "custom", path: ["questionAlternates", index, "question"], message });
      });
    });
    if (lesson.questionAlternates.length !== lesson.questions.length) {
      context.addIssue({ code: "custom", path: ["questionAlternates"], message: "Schema-v7 lessons need exactly one alternate per primary question." });
    }
    [...lesson.questions, ...lesson.questionAlternates.map((alternate) => alternate.question)].forEach((question) => {
      validateQuestionGlossaryCoverage(question, lesson.glossary).forEach((message) => {
        context.addIssue({ code: "custom", path: ["glossary"], message });
      });
      if (question.evaluationMode !== QUESTION_FORMAT_REGISTRY[question.type].evaluationMode) {
        context.addIssue({ code: "custom", path: ["questions"], message: `${question.type} must use ${QUESTION_FORMAT_REGISTRY[question.type].evaluationMode} evaluation.` });
      }
      if (isWrittenAnswerFormat(question.type) && !question.answerBank) {
        context.addIssue({ code: "custom", path: ["questions"], message: `${question.type} question ${question.id} needs an answer bank.` });
      }
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
    completedQuestionIds: z.array(id).max(23),
    attemptsByQuestion: z.record(id, z.number().int().min(0).max(100)),
    firstTryCorrect: z.number().int().min(0).max(23),
    totalQuestions: z.number().int().min(8).max(23),
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
  if (lesson.questions.some((question) => !LESSON_QUESTION_FORMATS.includes(question.type as (typeof LESSON_QUESTION_FORMATS)[number]))) {
    errors.push("Lesson contains a format that is no longer generated.");
  }
  return errors;
}

export interface LessonExpectation {
  unitId: string;
  targetLanguage: string;
  sourceLanguage: string;
  level: LearningProfile["level"];
  questionCount: number;
  speaking: boolean;
  allowedFormats: LessonQuestionFormat[];
}

export function validateLessonForExpectation(lesson: Lesson, expectation: LessonExpectation): string[] {
  const errors: string[] = [];
  const allowedFormats = new Set<LessonQuestionFormat>(expectation.allowedFormats);
  if (lesson.schemaVersion !== 7) errors.push("Generated lessons must use schemaVersion 7.");
  if (new Set(lesson.questions.map((question) => question.type)).size < 5) {
    errors.push("Lesson must use at least five formats.");
  }
  const speakingFormatAllowed = expectation.allowedFormats.some((format) => format === "speakingRepeat" || format === "speakingRoleplay");
  if (expectation.speaking && speakingFormatAllowed && !lesson.questions.some((question) => question.type === "speakingRepeat" || question.type === "speakingRoleplay")) {
    errors.push("Speaking is enabled, so the lesson needs at least one speaking question.");
  }
  if (lesson.questions.some((question) => !allowedFormats.has(question.type))) {
    errors.push("Lesson contains a disabled question format.");
  }
  if (lesson.questions.some((question) => !supportsQuestionFormatForLanguage(question.type, expectation.targetLanguage))) {
    errors.push("Lesson contains a question format unavailable for the target language.");
  }
  if (lesson.questions.some((question) => question.presentation !== undefined)) {
    errors.push("Generated questions must not provide presentation settings.");
  }
  lesson.questions.forEach((question) => {
    if (question.evaluationMode !== QUESTION_FORMAT_REGISTRY[question.type].evaluationMode) {
      errors.push(`${question.type} must use ${QUESTION_FORMAT_REGISTRY[question.type].evaluationMode} evaluation.`);
    }
  });
  const primaryById = new Map(lesson.questions.map((question) => [question.id, question]));
  const alternatesByQuestion = new Map<string, Lesson["questions"][number]>();
  lesson.questionAlternates.forEach(({ questionId, question }) => {
    if (alternatesByQuestion.has(questionId)) errors.push(`Question ${questionId} has more than one alternate.`);
    alternatesByQuestion.set(questionId, question);
    const primary = primaryById.get(questionId);
    if (!primary) errors.push(`Alternate ${question.id} references unknown question ${questionId}.`);
    if (primary?.type === question.type) errors.push(`Alternate ${question.id} must use a different format from ${questionId}.`);
    if (!allowedFormats.has(question.type)) errors.push(`Alternate ${question.id} uses a disabled question format.`);
    if (question.presentation !== undefined) errors.push(`Alternate ${question.id} must not provide presentation settings.`);
    if (question.evaluationMode !== QUESTION_FORMAT_REGISTRY[question.type].evaluationMode) {
      errors.push(`${question.type} alternate must use ${QUESTION_FORMAT_REGISTRY[question.type].evaluationMode} evaluation.`);
    }
    if (primary && isListeningQuestionFormat(primary.type) && isListeningQuestionFormat(question.type)) {
      errors.push(`Listening alternate ${question.id} cannot require listening.`);
    }
    if (!supportsQuestionFormatForLanguage(question.type, expectation.targetLanguage)) {
      errors.push(`Alternate ${question.id} is unavailable for ${expectation.targetLanguage}.`);
    }
  });
  lesson.questions.forEach((question) => {
    if (!alternatesByQuestion.has(question.id)) errors.push(`Question ${question.id} is missing its alternate.`);
  });
  if (lesson.questionAlternates.length !== lesson.questions.length) {
    errors.push("Generated lessons need exactly one alternate per primary question.");
  }
  if (lesson.unitId !== expectation.unitId) errors.push(`lesson.unitId must equal ${expectation.unitId}.`);
  if (lesson.targetLanguage.trim().toLocaleLowerCase() !== expectation.targetLanguage.trim().toLocaleLowerCase()) {
    errors.push(`lesson.targetLanguage must equal ${expectation.targetLanguage}.`);
  }
  if (lesson.sourceLanguage.trim().toLocaleLowerCase() !== expectation.sourceLanguage.trim().toLocaleLowerCase()) {
    errors.push(`lesson.sourceLanguage must equal ${expectation.sourceLanguage}.`);
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
