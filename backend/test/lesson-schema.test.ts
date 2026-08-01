import { describe, expect, it } from "vitest";
import {
  LessonCreateSchema,
  LessonPayloadSchema,
  QuestionSchema,
} from "../src/http/schemas";

const UNIT_ID = "9446e78a-63b7-43c7-9e3f-2dc05cff5698";
const COLLECTION_ID = "f29944bb-7fcc-4ab8-a3d8-a968734fbbbd";

function tracking(words = ["cat"]) {
  return {
    encountered: { words, phrases: [], sentences: [] },
    assessed: { words, phrases: [], sentences: [] },
  };
}

function questionCore(id: string) {
  return {
    id,
    prompt: "Practice cat.",
    explanation: "This exercise practices cat.",
    evaluationMode: "local",
    glossaryTargets: ["cat"],
    tracking: tracking(),
  };
}

function questionForType(type: string, id: string): Record<string, unknown> {
  const core = questionCore(id);
  switch (type) {
    case "singleChoice":
      return {
        ...core,
        type,
        options: [
          { id: "cat", label: "cat" },
          { id: "dog", label: "dog" },
        ],
        correctOptionId: "cat",
      };
    case "multipleChoice":
      return {
        ...core,
        type,
        options: [
          { id: "cat", label: "cat" },
          { id: "feline", label: "feline" },
        ],
        correctOptionIds: ["cat", "feline"],
      };
    case "trueFalse":
      return { ...core, type, statement: "A cat is an animal.", correct: true };
    case "fillBlank":
      return {
        ...core,
        type,
        template: "A {{blank}} purrs.",
        acceptedAnswers: ["cat"],
        answerBank: {
          tokens: [
            { id: "cat", label: "cat" },
            { id: "dog", label: "dog" },
          ],
          separator: "space",
          defaultMode: "bank",
        },
      };
    case "selectBlank":
      return {
        ...core,
        type,
        template: "A {{blank}} purrs.",
        options: [
          { id: "cat", label: "cat" },
          { id: "dog", label: "dog" },
        ],
        correctOptionId: "cat",
      };
    case "multiCloze":
      return {
        ...core,
        type,
        template: "A {{blank:animal}} can {{blank:sound}}.",
        blanks: [
          { id: "animal", acceptedAnswers: ["cat"] },
          { id: "sound", acceptedAnswers: ["purr"] },
        ],
        answerBank: {
          tokens: [
            { id: "cat", label: "cat" },
            { id: "purr", label: "purr" },
          ],
          separator: "space",
          defaultMode: "bank",
        },
      };
    case "wordBank":
      return {
        ...core,
        type,
        tokens: [
          { id: "a", label: "a" },
          { id: "cat", label: "cat" },
        ],
        correctOrderIds: ["a", "cat"],
      };
    case "matching":
      return {
        ...core,
        type,
        pairs: [
          { leftId: "cat", left: "cat", rightId: "feline", right: "feline" },
          { leftId: "dog", left: "dog", rightId: "canine", right: "canine" },
        ],
      };
    case "reorderTokens":
      return {
        ...core,
        type,
        tokens: [
          { id: "a", label: "A" },
          { id: "cat", label: "cat" },
        ],
        correctOrderIds: ["a", "cat"],
      };
    case "reorderDialogue":
      return {
        ...core,
        type,
        turns: [
          { id: "ask", label: "Is that a cat?", speaker: "A" },
          { id: "answer", label: "Yes.", speaker: "B" },
        ],
        correctOrderIds: ["ask", "answer"],
      };
    case "categorize":
      return {
        ...core,
        type,
        categories: [
          { id: "animal", label: "Animal" },
          { id: "object", label: "Object" },
        ],
        items: [
          { id: "cat", label: "cat", categoryId: "animal" },
          { id: "chair", label: "chair", categoryId: "object" },
        ],
      };
    case "translation":
      return {
        ...core,
        type,
        evaluationMode: "ai",
        sourceText: "chat",
        targetLanguage: "English",
        referenceAnswer: "cat",
        rubric: ["Use the correct noun."],
        answerBank: {
          tokens: [
            { id: "cat", label: "cat" },
            { id: "dog", label: "dog" },
          ],
          separator: "space",
          defaultMode: "bank",
        },
      };
    case "shortAnswer":
      return {
        ...core,
        type,
        evaluationMode: "ai",
        referenceAnswer: "A cat purrs.",
        requiredIdeas: ["cat", "purr"],
        rubric: ["Mention the animal and sound."],
        answerBank: {
          tokens: [
            { id: "a", label: "A" },
            { id: "cat", label: "cat" },
            { id: "purrs", label: "purrs" },
          ],
          separator: "space",
          defaultMode: "keyboard",
        },
      };
    case "errorCorrection":
      return {
        ...core,
        type,
        incorrectText: "A cat purr.",
        acceptedAnswers: ["A cat purrs."],
        answerBank: {
          tokens: [
            { id: "a", label: "A" },
            { id: "cat", label: "cat" },
            { id: "purrs", label: "purrs" },
          ],
          separator: "space",
          defaultMode: "bank",
        },
      };
    case "sentenceTransformation":
      return {
        ...core,
        type,
        sourceText: "The cat purrs.",
        constraint: "Use the past tense.",
        acceptedAnswers: ["The cat purred."],
        answerBank: {
          tokens: [
            { id: "the", label: "The" },
            { id: "cat", label: "cat" },
            { id: "purred", label: "purred" },
          ],
          separator: "space",
          defaultMode: "bank",
        },
      };
    case "dictation":
      return {
        ...core,
        type,
        transcript: "A cat purrs.",
        acceptedAnswers: ["A cat purrs."],
        answerBank: {
          tokens: [
            { id: "a", label: "A" },
            { id: "cat", label: "cat" },
            { id: "purrs", label: "purrs" },
          ],
          separator: "space",
          defaultMode: "bank",
        },
      };
    case "freeWriting":
      return {
        ...core,
        type,
        evaluationMode: "ai",
        minWords: 10,
        maxWords: 50,
        rubric: ["Describe a cat."],
        answerBank: {
          tokens: [
            { id: "cat", label: "cat" },
            { id: "small", label: "small" },
            { id: "soft", label: "soft" },
            { id: "purr", label: "purr" },
            { id: "play", label: "play" },
            { id: "sleep", label: "sleep" },
            { id: "animal", label: "animal" },
            { id: "pet", label: "pet" },
          ],
          separator: "space",
          defaultMode: "keyboard",
        },
      };
    case "speakingRepeat":
      return {
        ...core,
        type,
        evaluationMode: "ai",
        modelText: "A cat purrs.",
        rubric: ["Repeat the sentence clearly."],
      };
    case "speakingRoleplay":
      return {
        ...core,
        type,
        evaluationMode: "ai",
        role: "Cat owner",
        scenario: "You are describing your cat.",
        goal: "Describe the cat.",
        rubric: ["Speak clearly."],
      };
    case "listenSelect":
      return {
        ...core,
        type,
        audioText: "cat",
        options: [
          { id: "cat", label: "cat" },
          { id: "dog", label: "dog" },
        ],
        correctOptionId: "cat",
      };
    case "audioMatching":
      return {
        ...core,
        type,
        pairs: [
          { audioId: "cat-audio", audioText: "cat", matchId: "cat", label: "cat" },
          { audioId: "dog-audio", audioText: "dog", matchId: "dog", label: "dog" },
        ],
      };
    case "soundDiscrimination":
      return {
        ...core,
        type,
        audioText: "cat",
        options: [
          { id: "cat", label: "cat" },
          { id: "cut", label: "cut" },
        ],
        correctOptionId: "cat",
      };
    case "flashcardRecall":
      return { ...core, type, cue: "cat", acceptedAnswers: ["cat"] };
    default:
      throw new Error(`Unsupported test question type: ${type}`);
  }
}

const primaryTypes = [
  "singleChoice",
  "multipleChoice",
  "trueFalse",
  "wordBank",
  "matching",
  "reorderTokens",
  "reorderDialogue",
  "categorize",
] as const;

const alternateTypes = [
  "trueFalse",
  "wordBank",
  "matching",
  "reorderTokens",
  "reorderDialogue",
  "categorize",
  "singleChoice",
  "multipleChoice",
] as const;

function validLessonPayload() {
  const questions = primaryTypes.map((type, index) =>
    questionForType(type, `question-${index + 1}`),
  );
  const questionAlternates = alternateTypes.map((type, index) => ({
    questionId: `question-${index + 1}`,
    question: questionForType(type, `alternate-${index + 1}`),
  }));

  return {
    schemaVersion: 8,
    id: "lesson-v8",
    unitId: UNIT_ID,
    title: "Cat lesson",
    summary: "Learn and practice cat vocabulary.",
    targetLanguage: "English",
    sourceLanguage: "Vietnamese",
    level: "beginner",
    objectives: ["Recognize and use cat vocabulary."],
    theory: [
      {
        id: "theory-1",
        kind: "concept",
        title: "Cat",
        body: "Cat is an animal noun.",
      },
    ],
    examples: [{ id: "example-1", source: "cat", translation: "mèo" }],
    glossary: [{ term: "cat", meaning: "mèo" }],
    sourceReferences: [{ id: "source-1", kind: "unit", title: "Cat unit" }],
    questions,
    questionAlternates,
    createdAt: "2026-07-30T10:00:00.000Z",
  };
}

function cloneLesson() {
  return structuredClone(validLessonPayload());
}

describe("Lesson payload v8 contract", () => {
  it("accepts a complete frontend-compatible payload", () => {
    expect(LessonPayloadSchema.safeParse(validLessonPayload()).success).toBe(true);
  });

  it("supports every frontend lesson question format and rejects unknown formats", () => {
    const formats = [
      "singleChoice",
      "multipleChoice",
      "trueFalse",
      "fillBlank",
      "selectBlank",
      "multiCloze",
      "wordBank",
      "matching",
      "reorderTokens",
      "reorderDialogue",
      "categorize",
      "translation",
      "shortAnswer",
      "errorCorrection",
      "sentenceTransformation",
      "dictation",
      "freeWriting",
      "speakingRepeat",
      "speakingRoleplay",
      "listenSelect",
      "audioMatching",
      "soundDiscrimination",
      "flashcardRecall",
    ];
    formats.forEach((format, index) => {
      expect(
        QuestionSchema.safeParse(questionForType(format, `format-${index}`)).success,
        format,
      ).toBe(true);
    });
    expect(
      QuestionSchema.safeParse({
        ...questionCore("unknown"),
        type: "madeUpQuestion",
      }).success,
    ).toBe(false);
  });

  it("bounds duplicate-label answer-bank composition with an impossible suffix", () => {
    const question = questionForType("translation", "duplicate-bank");
    Object.assign(question, {
      referenceAnswer: `${Array.from({ length: 29 }, () => "go").join(" ")} x.`,
      answerBank: {
        tokens: Array.from({ length: 30 }, (_, index) => ({
          id: `repeat-${index}`,
          label: "go",
        })),
        separator: "space",
        defaultMode: "bank",
      },
    });

    const parsed = QuestionSchema.safeParse(question);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("compose an answer exactly")))
        .toBe(true);
    }
  }, 1_000);

  it("preserves repeated answer-bank tokens needed by a valid composition", () => {
    const question = questionForType("translation", "repeated-bank");
    Object.assign(question, {
      referenceAnswer: "go go go.",
      answerBank: {
        tokens: [
          { id: "go-1", label: "go" },
          { id: "go-2", label: "go" },
          { id: "go-3", label: "go" },
          { id: "distractor", label: "stay" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    });

    expect(QuestionSchema.safeParse(question).success).toBe(true);
  });

  it("rejects pathological overlapping compositions at a deterministic state limit", () => {
    const question = questionForType("translation", "overlapping-bank");
    Object.assign(question, {
      referenceAnswer: `${"a".repeat(180)} ${"a".repeat(50)} b.`,
      answerBank: {
        tokens: Array.from({ length: 30 }, (_, index) => ({
          id: `overlap-${index}`,
          label: "a".repeat(index + 1),
        })),
        separator: "none",
        defaultMode: "bank",
      },
    });

    const parsed = QuestionSchema.safeParse(question);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("validation complexity limit")))
        .toBe(true);
    }
  }, 1_000);

  it("bounds aggregate composition work across a maximum-size lesson envelope", () => {
    const baseQuestion = questionForType("errorCorrection", "aggregate-bank");
    const pathologicalQuestion = {
      ...baseQuestion,
      acceptedAnswers: [`${"a".repeat(21)}b.`],
      answerBank: {
        tokens: Array.from({ length: 6 }, (_, index) => ({
          id: `aggregate-${index}`,
          label: "a".repeat(index + 1),
        })).concat({ id: "aggregate-distractor", label: "c" }),
        separator: "none",
        defaultMode: "bank",
      },
    };

    const singleQuestion = QuestionSchema.safeParse(pathologicalQuestion);
    expect(singleQuestion.success).toBe(false);
    if (!singleQuestion.success) {
      expect(singleQuestion.error.issues.some((issue) => issue.message.includes("complexity limit")))
        .toBe(false);
    }

    const parsed = LessonPayloadSchema.safeParse({
      targetLanguage: "English",
      questions: Array.from({ length: 23 }, (_, index) => ({
        ...pathologicalQuestion,
        id: `aggregate-primary-${index}`,
      })),
      questionAlternates: Array.from({ length: 23 }, (_, index) => ({
        questionId: `aggregate-primary-${index}`,
        question: {
          ...pathologicalQuestion,
          id: `aggregate-alternate-${index}`,
        },
      })),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("validation complexity limit")))
        .toBe(true);
    }
  }, 1_500);

  it("requires the frontend top-level fields and rejects unknown fields", () => {
    const missingSummary = cloneLesson();
    Reflect.deleteProperty(missingSummary, "summary");
    expect(LessonPayloadSchema.safeParse(missingSummary).success).toBe(false);

    const extraTopLevel = { ...cloneLesson(), privateAnswerKey: "nope" };
    expect(LessonPayloadSchema.safeParse(extraTopLevel).success).toBe(false);

    const extraQuestion = cloneLesson();
    Object.assign(extraQuestion.questions[0]!, { legacyFormat: true });
    expect(LessonPayloadSchema.safeParse(extraQuestion).success).toBe(false);
  });

  it("requires globally unique primary and alternate IDs", () => {
    const duplicatePrimary = cloneLesson();
    duplicatePrimary.questions[1]!.id = duplicatePrimary.questions[0]!.id;
    expect(LessonPayloadSchema.safeParse(duplicatePrimary).success).toBe(false);

    const duplicateAlternate = cloneLesson();
    duplicateAlternate.questionAlternates[1]!.question.id =
      duplicateAlternate.questionAlternates[0]!.question.id;
    expect(LessonPayloadSchema.safeParse(duplicateAlternate).success).toBe(false);

    const primaryAlternateCollision = cloneLesson();
    primaryAlternateCollision.questionAlternates[0]!.question.id =
      primaryAlternateCollision.questions[0]!.id;
    expect(
      LessonPayloadSchema.safeParse(primaryAlternateCollision).success,
    ).toBe(false);
  });

  it("requires exactly one alternate for every primary", () => {
    const duplicateSlot = cloneLesson();
    duplicateSlot.questionAlternates[1]!.questionId =
      duplicateSlot.questionAlternates[0]!.questionId;
    expect(LessonPayloadSchema.safeParse(duplicateSlot).success).toBe(false);

    const unknownSlot = cloneLesson();
    unknownSlot.questionAlternates[0]!.questionId = "missing-primary";
    expect(LessonPayloadSchema.safeParse(unknownSlot).success).toBe(false);

    const missingAlternate = cloneLesson();
    missingAlternate.questionAlternates.pop();
    expect(LessonPayloadSchema.safeParse(missingAlternate).success).toBe(false);
  });

  it("requires alternate tracking to describe the same learning targets", () => {
    const mismatch = cloneLesson();
    mismatch.questionAlternates[0]!.question.tracking = tracking(["dog"]);
    expect(LessonPayloadSchema.safeParse(mismatch).success).toBe(false);

    const reordered = cloneLesson();
    reordered.questions[0]!.tracking = tracking(["cat", "feline"]);
    reordered.questionAlternates[0]!.question.tracking = tracking(["feline", "cat"]);
    expect(LessonPayloadSchema.safeParse(reordered).success).toBe(true);
  });

  it("rejects duplicate tracking targets and assessed targets not encountered", () => {
    const duplicate = cloneLesson();
    duplicate.questions[0]!.tracking = tracking(["cat", "cat"]);
    expect(LessonPayloadSchema.safeParse(duplicate).success).toBe(false);

    const unencountered = cloneLesson();
    unencountered.questions[0]!.tracking = {
      encountered: { words: ["cat"], phrases: [], sentences: [] },
      assessed: { words: ["dog"], phrases: [], sentences: [] },
    };
    expect(LessonPayloadSchema.safeParse(unencountered).success).toBe(false);
  });

  it("keeps API metadata consistent with the immutable payload", () => {
    const payload = validLessonPayload();
    const body = {
      collectionId: COLLECTION_ID,
      unitId: UNIT_ID,
      unitRevision: 1,
      title: payload.title,
      languageCode: "en",
      payload,
    };
    expect(LessonCreateSchema.safeParse(body).success).toBe(true);
    expect(
      LessonCreateSchema.safeParse({ ...body, unitId: COLLECTION_ID }).success,
    ).toBe(false);
    expect(
      LessonCreateSchema.safeParse({ ...body, title: "Different title" }).success,
    ).toBe(false);
  });
});
