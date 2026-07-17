import { describe, expect, it } from "vitest";
import { gradeAnswer, normalizeAnswer } from "./grader";
import { firstTryAccuracy, shouldFlushProgress } from "./progress";
import { DEFAULT_LEARNING_PROFILE, normalizeLearningProfile, resolveLearningProfile } from "./profile";
import { applyAttempt, createRetryState, masteryPercent, scheduleRetry } from "./retry";
import { jsonByteLength, lessonSchema, parseEvaluation, validateLessonForExpectation, validateLessonForProfile } from "./schema";
import type { AttemptRecord, Lesson, LessonQuestion, QuestionAnswer } from "./types";

const common = {
  explanation: "Giải thích ngắn.",
  hint: "Gợi ý.",
  evaluationMode: "local" as const,
};

const questions: LessonQuestion[] = [
  { ...common, id: "single", type: "singleChoice", prompt: "Chọn A", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionId: "a" },
  { ...common, id: "multiple", type: "multipleChoice", prompt: "Chọn A và B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], correctOptionIds: ["a", "b"] },
  { ...common, id: "tf", type: "trueFalse", prompt: "Đúng hay sai?", statement: "A là A", correct: true },
  { ...common, id: "blank", type: "fillBlank", prompt: "Điền từ", template: "Good ___", acceptedAnswers: ["morning"], match: { ignorePunctuation: true } },
  { ...common, id: "cloze", type: "multiCloze", prompt: "Điền hai từ", template: "__ __", blanks: [{ id: "one", acceptedAnswers: ["good"] }, { id: "two", acceptedAnswers: ["morning"] }] },
  { ...common, id: "bank", type: "wordBank", prompt: "Xếp từ", tokens: [{ id: "good", label: "Good" }, { id: "morning", label: "morning" }], correctOrderIds: ["good", "morning"] },
  { ...common, id: "match", type: "matching", prompt: "Ghép", pairs: [{ leftId: "l1", left: "Hello", rightId: "r1", right: "Xin chào" }, { leftId: "l2", left: "Bye", rightId: "r2", right: "Tạm biệt" }] },
  { ...common, id: "tokens", type: "reorderTokens", prompt: "Xếp câu", tokens: [{ id: "i", label: "I" }, { id: "learn", label: "learn" }], correctOrderIds: ["i", "learn"] },
  { ...common, id: "dialogue", type: "reorderDialogue", prompt: "Xếp hội thoại", turns: [{ id: "hi", label: "Hello", speaker: "A" }, { id: "hey", label: "Hi", speaker: "B" }], correctOrderIds: ["hi", "hey"] },
  { ...common, id: "category", type: "categorize", prompt: "Phân loại", categories: [{ id: "noun", label: "Noun" }, { id: "verb", label: "Verb" }], items: [{ id: "book", label: "book", categoryId: "noun" }, { id: "read", label: "read", categoryId: "verb" }] },
  { ...common, id: "translation", type: "translation", prompt: "Dịch", sourceText: "Xin chào", targetLanguage: "English", referenceAnswer: "Hello", rubric: ["Meaning"], evaluationMode: "ai" },
  { ...common, id: "short", type: "shortAnswer", prompt: "Trả lời", referenceAnswer: "Because it is polite.", requiredIdeas: ["polite"], rubric: ["Meaning"], evaluationMode: "ai" },
  { ...common, id: "error", type: "errorCorrection", prompt: "Sửa lỗi", incorrectText: "He go home.", acceptedAnswers: ["He goes home."], match: { ignorePunctuation: true } },
  { ...common, id: "transform", type: "sentenceTransformation", prompt: "Đổi câu", sourceText: "I work at nine.", constraint: "Use starts", acceptedAnswers: ["Work starts at nine."], match: { ignorePunctuation: true } },
  { ...common, id: "dictation", type: "dictation", prompt: "Nghe và chép", transcript: "Good morning", acceptedAnswers: ["Good morning"], match: { ignorePunctuation: true } },
  { ...common, id: "writing", type: "freeWriting", prompt: "Viết đoạn", minWords: 20, maxWords: 80, rubric: ["Clarity"], evaluationMode: "ai" },
  { ...common, id: "repeat", type: "speakingRepeat", prompt: "Lặp lại", modelText: "Good morning", rubric: ["Fluency"], evaluationMode: "ai" },
  { ...common, id: "roleplay", type: "speakingRoleplay", prompt: "Đóng vai", role: "Customer", scenario: "At a cafe", goal: "Order coffee", rubric: ["Task completion"], evaluationMode: "ai" },
];

const correctAnswers: Record<LessonQuestion["type"], QuestionAnswer> = {
  singleChoice: "a",
  multipleChoice: ["a", "b"],
  trueFalse: true,
  fillBlank: "morning!",
  multiCloze: { one: "good", two: "morning" },
  wordBank: ["good", "morning"],
  matching: { l1: "r1", l2: "r2" },
  reorderTokens: ["i", "learn"],
  reorderDialogue: ["hi", "hey"],
  categorize: { book: "noun", read: "verb" },
  translation: "Hello",
  shortAnswer: "Because it is polite.",
  errorCorrection: "He goes home",
  sentenceTransformation: "Work starts at nine",
  dictation: "Good morning",
  freeWriting: "A longer paragraph",
  speakingRepeat: "Good morning",
  speakingRoleplay: "One coffee, please",
};

describe("the 18 question graders", () => {
  it.each(questions.map((question) => [question.type, question] as const))("handles %s", (_type, question) => {
    const result = gradeAnswer(question, correctAnswers[question.type]);
    if (["translation", "shortAnswer", "freeWriting", "speakingRepeat", "speakingRoleplay"].includes(question.type)) {
      expect(result.requiresAi).toBe(true);
    } else {
      expect(result.requiresAi).toBe(false);
      if (!result.requiresAi) expect(result.status).toBe("correct");
    }
  });

  it("returns partial credit without mastery", () => {
    const question = questions.find((item) => item.type === "multipleChoice")!;
    const result = gradeAnswer(question, ["a"]);
    expect(result.requiresAi).toBe(false);
    if (!result.requiresAi) {
      expect(result.status).toBe("partial");
      expect(result.score).toBe(0.5);
    }
  });

  it("normalizes Unicode, whitespace, punctuation, and diacritics", () => {
    expect(normalizeAnswer("  HÉLLO,   bạn!  ", { ignorePunctuation: true, ignoreDiacritics: true })).toBe("hello ban");
  });
});

describe("lesson schema", () => {
  const lesson: Lesson = {
    schemaVersion: 1,
    id: "lesson-1",
    unitId: "unit-1",
    title: "A varied lesson",
    summary: "A compact lesson used by tests.",
    targetLanguage: "English",
    level: "elementary",
    objectives: ["Use greetings"],
    theory: [{ id: "theory-1", kind: "concept", title: "Greetings", body: "Use greetings to open a conversation." }],
    examples: [{ id: "example-1", source: "Good morning", translation: "Chào buổi sáng" }],
    glossary: [{ term: "morning", meaning: "buổi sáng" }],
    sourceReferences: [{ id: "source-1", kind: "unit", title: "Unit context" }],
    questions: questions.slice(0, 10),
    createdAt: "2026-07-16T00:00:00.000Z",
  };

  it("accepts 8–15 questions with at least five formats", () => {
    expect(lessonSchema.parse(lesson).questions).toHaveLength(10);
    expect(jsonByteLength(lesson)).toBeGreaterThan(100);
  });

  it("requires a speaking question when the profile enables speaking", () => {
    expect(validateLessonForProfile(lesson, DEFAULT_LEARNING_PROFILE)).toContain(
      "Speaking is enabled, so the lesson needs at least one speaking question.",
    );
    const withSpeaking = { ...lesson, questions: [...lesson.questions.slice(0, 9), questions[16]] };
    expect(validateLessonForProfile(withSpeaking, DEFAULT_LEARNING_PROFILE)).toEqual([]);
  });

  it("matches the unit, language, level, exact count, and both grading modes", () => {
    const expectedLesson = { ...lesson, questions: [...lesson.questions.slice(0, 9), questions[10]] };
    const expectation = { unitId: "unit-1", targetLanguage: "English", level: "elementary" as const, questionCount: 10, speaking: false };
    expect(validateLessonForExpectation(expectedLesson, expectation)).toEqual([]);
    expect(validateLessonForExpectation({ ...expectedLesson, unitId: "wrong" }, expectation)).toContain("lesson.unitId must equal unit-1.");
    expect(validateLessonForExpectation({ ...expectedLesson, questions: expectedLesson.questions.slice(0, 9) }, expectation))
      .toContain("lesson.questions must contain exactly 10 items.");
  });
});

describe("direct ChatGPT evaluation schema", () => {
  it("accepts a strict bounded evaluation and rejects extra fields", () => {
    const evaluation = {
      status: "partial",
      score: 0.6,
      correctParts: ["Greeting"],
      errors: [{ location: "verb", message: "Use the present tense." }],
      correction: "I work here.",
      explanation: "The statement describes a current fact.",
      nextHint: "Check the verb tense.",
      pronunciationAssessed: false,
    };
    expect(parseEvaluation(evaluation).score).toBe(0.6);
    expect(() => parseEvaluation({ ...evaluation, persisted: true })).toThrow();
  });
});

describe("retry scheduler", () => {
  it("repeats an incorrect question after two other questions", () => {
    expect(scheduleRetry(["q2", "q3", "q4"], "q1")).toEqual(["q2", "q3", "q1", "q4"]);
  });

  it("moves correct questions to mastery and preserves first-try accuracy", () => {
    let state = createRetryState(["q1", "q2"]);
    state = applyAttempt(state, "q1", "incorrect");
    expect(state.queue).toEqual(["q2", "q1"]);
    state = applyAttempt(state, "q2", "correct");
    expect(state.firstTryCorrect).toBe(1);
    state = applyAttempt(state, "q1", "correct");
    expect(masteryPercent(state, 2)).toBe(100);
    expect(state.firstTryCorrect).toBe(1);
  });
});

describe("profile and progress normalization", () => {
  it("inherits defaults and clamps unsafe values", () => {
    const profile = resolveLearningProfile({ targetLanguage: "Spanish", dailyQuestionGoal: 999 }, { speakingEnabled: false });
    expect(profile.targetLanguage).toBe("Spanish");
    expect(profile.dailyQuestionGoal).toBe(100);
    expect(profile.speakingEnabled).toBe(false);
    expect(profile.interfaceLanguage).toBe("en");
    expect(normalizeLearningProfile({ interfaceLanguage: "vi" }).interfaceLanguage).toBe("en");
    expect(normalizeLearningProfile({ lessonQuestionCount: 2 }).lessonQuestionCount).toBe(8);
  });

  it("batches after five, completion, or hidden tab", () => {
    const attempts: AttemptRecord[] = Array.from({ length: 5 }, (_, index) => ({
      questionId: `q${index}`,
      attemptNumber: 1,
      status: index < 4 ? "correct" : "incorrect",
      score: index < 4 ? 1 : 0,
      firstTry: true,
      answeredAt: "2026-07-16T00:00:00.000Z",
    }));
    expect(shouldFlushProgress({ pending: attempts, lessonComplete: false, pageHidden: false })).toBe(true);
    expect(shouldFlushProgress({ pending: attempts.slice(0, 1), lessonComplete: true, pageHidden: false })).toBe(true);
    expect(shouldFlushProgress({ pending: attempts.slice(0, 1), lessonComplete: false, pageHidden: true })).toBe(true);
    expect(firstTryAccuracy(attempts, 5)).toBe(80);
  });
});
