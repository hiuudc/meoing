import { describe, expect, it } from "vitest";
import { createLocalPreviewLesson } from "./demoLesson";
import { detectBrowserLanguage, SUPPORTED_LANGUAGE_NAMES } from "./languages";
import { gradeAnswer, normalizeAnswer } from "./grader";
import { segmentGlossaryText } from "./glossary";
import { parseMultiClozeTemplate, validateMultiClozeMarkers } from "./multiCloze";
import {
  DEFAULT_TYPEAHEAD_TIMEOUT_MS,
  DEFAULT_SKIP_SHORTCUT,
  LISTENING_PAUSE_DURATION_MS,
  effectivePresentation,
  isForbiddenLessonShortcut,
  lessonShortcutLabel,
  lessonShortcutMatches,
  normalizeLessonPlayerPreference,
  normalizeTypeaheadTimeoutMs,
  pauseListening,
  resetLessonPlayerPreference,
  resetPresentationOverrides,
} from "./playerPreferences";
import { firstTryAccuracy, shouldFlushProgress } from "./progress";
import { DEFAULT_LEARNING_PROFILE, normalizeLearningProfile, resolveLearningProfile } from "./profile";
import { answerSpeechText, questionSpeechText } from "./questionContent";
import {
  buildQuestionGenerationConstraints,
  decorateLessonPresentation,
  getEffectiveCollectionQuestionSettings,
  normalizeCollectionQuestionSettings,
  validateCollectionQuestionSettings,
} from "./questionSettings";
import { applyAttempt, createRetryState, masteryPercent, scheduleRetry, skipQuestion, useListeningAlternate } from "./retry";
import {
  jsonByteLength,
  lessonQuestionSchema,
  lessonSchema,
  parseEvaluation,
  parseLessonProgressSnapshot,
  validateLessonForExpectation,
  validateLessonForProfile,
} from "./schema";
import {
  filterSpeechVoices,
  normalizeSpeechPreference,
  resolveSpeechVoice,
  speechTextForLanguage,
  voicePreviewSample,
} from "./speech";
import {
  LESSON_QUESTION_FORMATS,
  QUESTION_FORMATS,
  type AttemptRecord,
  type LessonQuestion,
  type QuestionAnswer,
} from "./types";

const common = {
  explanation: "Giải thích ngắn.",
  hint: "Gợi ý.",
  evaluationMode: "local" as const,
};

const questions: LessonQuestion[] = [
  { ...common, id: "single", type: "singleChoice", prompt: "Chọn A", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctOptionId: "a" },
  { ...common, id: "multiple", type: "multipleChoice", prompt: "Chọn A và B", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], correctOptionIds: ["a", "b"] },
  { ...common, id: "tf", type: "trueFalse", prompt: "Đúng hay sai?", statement: "A là A", correct: true },
  { ...common, id: "blank", type: "fillBlank", prompt: "Điền từ", template: "Good {{blank}}", acceptedAnswers: ["morning"], match: { ignorePunctuation: true } },
  { ...common, id: "select-blank", type: "selectBlank", prompt: "Chọn từ", template: "Good {{blank}}", options: [{ id: "morning", label: "morning" }, { id: "night", label: "night" }], correctOptionId: "morning" },
  { ...common, id: "cloze", type: "multiCloze", prompt: "Điền hai từ", template: "{{blank:one}} {{blank:two}}", blanks: [{ id: "one", acceptedAnswers: ["good"] }, { id: "two", acceptedAnswers: ["morning"] }] },
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
  { ...common, id: "listen-select", type: "listenSelect", prompt: "Listen and choose", audioText: "water", options: [{ id: "listen-correct", label: "water" }, { id: "listen-wrong", label: "tea" }], correctOptionId: "listen-correct" },
  { ...common, id: "audio-match", type: "audioMatching", prompt: "Match the audio", pairs: [{ audioId: "audioOne", audioText: "water", matchId: "meaningOne", label: "nước" }, { audioId: "audioTwo", audioText: "tea", matchId: "meaningTwo", label: "trà" }] },
  { ...common, id: "sound", type: "soundDiscrimination", prompt: "Choose the sound", audioText: "ship", options: [{ id: "sound-correct", label: "ship" }, { id: "sound-wrong", label: "sheep" }], correctOptionId: "sound-correct" },
  { ...common, id: "flashcard", type: "flashcardRecall", prompt: "Recall water", cue: "nước", acceptedAnswers: ["water"], match: { ignorePunctuation: true } },
];

const correctAnswers: Record<LessonQuestion["type"], QuestionAnswer> = {
  singleChoice: "a",
  multipleChoice: ["a", "b"],
  trueFalse: true,
  fillBlank: "morning!",
  selectBlank: "morning",
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
  listenSelect: "listen-correct",
  audioMatching: { audioOne: "meaningOne", audioTwo: "meaningTwo" },
  soundDiscrimination: "sound-correct",
  flashcardRecall: "water",
};

describe("the question graders", () => {
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

  it("grades Translation and Short Answer locally only in word-bank mode", () => {
    const translation = {
      ...common,
      id: "bank-translation",
      type: "translation" as const,
      prompt: "Translate",
      sourceText: "Tôi uống nước.",
      targetLanguage: "English",
      referenceAnswer: "I drink water.",
      rubric: ["Meaning"],
      evaluationMode: "ai" as const,
    };
    const shortAnswer = {
      ...common,
      id: "bank-short-answer",
      type: "shortAnswer" as const,
      prompt: "Answer",
      referenceAnswer: "Because it is polite.",
      requiredIdeas: ["polite"],
      rubric: ["Meaning"],
      evaluationMode: "ai" as const,
    };

    expect(gradeAnswer(translation, "I drink water", { inputMode: "bank" })).toMatchObject({
      requiresAi: false,
      status: "correct",
    });
    expect(gradeAnswer(shortAnswer, "because it is polite!", { inputMode: "bank" })).toMatchObject({
      requiresAi: false,
      status: "correct",
    });
    expect(gradeAnswer(translation, "water drink I", { inputMode: "bank" })).toMatchObject({
      requiresAi: false,
      status: "incorrect",
    });
    expect(gradeAnswer(translation, "I drink water", { inputMode: "keyboard" })).toEqual({
      requiresAi: true,
      reason: "semantic",
    });
    expect(gradeAnswer(shortAnswer, "Because it is polite.", { inputMode: "keyboard" })).toEqual({
      requiresAi: true,
      reason: "semantic",
    });
  });

});

describe("lesson schema", () => {
  const lesson = createLocalPreviewLesson("unit-1", "Schema", {
    ...DEFAULT_LEARNING_PROFILE,
    speakingEnabled: false,
    sourceLanguage: "Vietnamese",
    targetLanguage: "English",
    lessonQuestionCount: 15,
  });

  it("accepts only strict schema v7 lessons", () => {
    expect(lessonSchema.parse(lesson).questions).toHaveLength(23);
    expect(jsonByteLength(lesson)).toBeGreaterThan(100);
    expect(() => lessonSchema.parse({ ...lesson, schemaVersion: 6 })).toThrow();
    expect(() => lessonSchema.parse({
      ...lesson,
      questions: lesson.questions.map((question, index) => (
        index === 0 ? { ...question, templateId: "removed-blueprint" } : question
      )),
    })).toThrow();
  });

  it("matches the v7 lesson expectation without blueprint fields", () => {
    const generatedLesson = {
      ...lesson,
      questions: lesson.questions.map(({ presentation: _presentation, ...question }) => question),
      questionAlternates: lesson.questionAlternates.map((alternate) => {
        const { presentation: _presentation, ...question } = alternate.question;
        return { ...alternate, question };
      }),
    };
    const expectation = {
      unitId: lesson.unitId,
      targetLanguage: lesson.targetLanguage,
      sourceLanguage: lesson.sourceLanguage,
      level: lesson.level,
      questionCount: lesson.questions.length,
      speaking: false,
      allowedFormats: [...LESSON_QUESTION_FORMATS],
    };
    expect(validateLessonForExpectation(generatedLesson, expectation)).toEqual([]);
    expect(validateLessonForExpectation({ ...generatedLesson, unitId: "wrong" }, expectation))
      .toContain(`lesson.unitId must equal ${lesson.unitId}.`);
    expect(validateLessonForExpectation({ ...generatedLesson, sourceLanguage: "German" }, expectation))
      .toContain(`lesson.sourceLanguage must equal ${lesson.sourceLanguage}.`);
    expect(validateLessonForExpectation({ ...generatedLesson, questions: generatedLesson.questions.slice(0, 22) }, expectation))
      .toContain(`lesson.questions must contain exactly ${lesson.questions.length} items.`);
    expect(validateLessonForProfile(lesson, { ...DEFAULT_LEARNING_PROFILE, speakingEnabled: false })).toContain(
      "Lesson must have 8-15 questions.",
    );
  });

  it("accepts only inline blank markers and validates named multi-blank IDs", () => {
    const fill = questions.find((question) => question.type === "fillBlank")!;
    expect(() => lessonQuestionSchema.parse(fill)).not.toThrow();
    expect(() => lessonQuestionSchema.parse({ ...fill, template: "Good ___" })).toThrow(/exactly one/);
    expect(() => lessonQuestionSchema.parse({ ...fill, template: "Good {{blank:word}}" })).not.toThrow();

    expect(validateMultiClozeMarkers(
      "{{blank:subject}} drinks {{blank:object}}.",
      ["subject", "object"],
    )).toEqual([]);
    expect(validateMultiClozeMarkers(
      "{{blank:subject}} drinks {{blank:subject}}.",
      ["subject", "object"],
    )).toEqual(expect.arrayContaining([
      "Multi-blank marker subject appears more than once.",
      "Multi-blank marker object is missing.",
    ]));
    expect(validateMultiClozeMarkers(
      "{{blank:subject}} drinks {{blank:unknown}}.",
      ["subject", "object"],
    )).toEqual(expect.arrayContaining([
      "Unknown multi-blank marker unknown.",
      "Multi-blank marker object is missing.",
    ]));

    expect(parseMultiClozeTemplate("{{blank:subject}} drinks {{blank:object}}.", ["subject", "object"])).toEqual({
      markerIds: ["subject", "object"],
      segments: ["", " drinks ", "."],
    });
    expect(parseMultiClozeTemplate("__ drinks __.", ["subject", "object"])).toBeNull();
  });

  it("builds exactly two semantic preview blanks for every target language", () => {
    SUPPORTED_LANGUAGE_NAMES.forEach((targetLanguage) => {
      const preview = createLocalPreviewLesson(`unit-${targetLanguage}`, targetLanguage, {
        ...DEFAULT_LEARNING_PROFILE,
        sourceLanguage: "English",
        targetLanguage,
        speakingEnabled: false,
        lessonQuestionCount: 15,
      });
      const cloze = preview.questions.find(
        (question): question is Extract<LessonQuestion, { type: "multiCloze" }> => question.type === "multiCloze",
      )!;

      expect(new Set(cloze.blanks.map((blank) => blank.id)))
        .toEqual(new Set(["blank-water", "blank-drink"]));
      expect(cloze.template.match(/\{\{blank:[^{}]+\}\}/g)).toHaveLength(2);
      expect(validateMultiClozeMarkers(cloze.template, cloze.blanks.map((blank) => blank.id))).toEqual([]);
    });

    const japanese = createLocalPreviewLesson("unit-ja-two-blanks", "Japanese", {
      ...DEFAULT_LEARNING_PROFILE,
      sourceLanguage: "English",
      targetLanguage: "Japanese",
      speakingEnabled: false,
      lessonQuestionCount: 15,
    });
    const japaneseCloze = japanese.questions.find(
      (question): question is Extract<LessonQuestion, { type: "multiCloze" }> => question.type === "multiCloze",
    )!;
    expect(japaneseCloze.template).toBe(
      "\u79c1\u306f{{blank:blank-water}}\u3092{{blank:blank-drink}}",
    );
    expect(japaneseCloze.blanks.map((blank) => blank.acceptedAnswers[0]))
      .toEqual(["\u6c34", "\u98f2\u307f\u307e\u3059"]);
  });

  it("rejects sentence-sized, punctuated, or incomplete Translation banks", () => {
    const translation = lesson.questions.find(
      (question): question is Extract<LessonQuestion, { type: "translation" }> => question.type === "translation",
    )!;
    const bank = translation.answerBank!;

    expect(() => lessonQuestionSchema.parse({
      ...translation,
      answerBank: {
        ...bank,
        tokens: [
          { id: "whole-answer", label: "I drink water" },
          { id: "distractor", label: "tea" },
        ],
      },
    })).toThrow(/complete sentence answer/);

    expect(() => lessonQuestionSchema.parse({
      ...translation,
      answerBank: {
        ...bank,
        tokens: bank.tokens.map((token, index) => (
          index === 0 ? { ...token, label: `${token.label}.` } : token
        )),
      },
    })).toThrow(/sentence-ending punctuation/);

    expect(() => lessonQuestionSchema.parse({
      ...translation,
      answerBank: {
        ...bank,
        tokens: bank.tokens.filter((token) => token.label.toLocaleLowerCase() !== "water"),
      },
    })).toThrow(/compose at least one complete answer exactly/);

    expect(() => lessonQuestionSchema.parse({
      ...translation,
      answerBank: {
        ...bank,
        tokens: [
          { id: "subject-verb", label: "I drink" },
          { id: "object", label: "water" },
        ],
      },
    })).not.toThrow();
  });

  it("allows a longer token only when it exactly fills one declared blank", () => {
    const fillBlank = questions.find(
      (question): question is Extract<LessonQuestion, { type: "fillBlank" }> => question.type === "fillBlank",
    )!;

    expect(() => lessonQuestionSchema.parse({
      ...fillBlank,
      template: "Stand {{blank}} me.",
      acceptedAnswers: ["in front of"],
      answerBank: {
        tokens: [
          { id: "correct", label: "in front of" },
          { id: "distractor", label: "behind" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    })).not.toThrow();

    expect(() => lessonQuestionSchema.parse({
      ...fillBlank,
      acceptedAnswers: ["water"],
      answerBank: {
        tokens: [
          { id: "sentence", label: "I drink water" },
          { id: "distractor", label: "tea" },
        ],
        separator: "space",
        defaultMode: "bank",
      },
    })).toThrow(/at most two lexical units/);
  });

  it("rejects complete sentence tokens across deterministic written-answer banks", () => {
    const deterministic = [
      {
        ...questions.find((question) => question.type === "errorCorrection")!,
        answerBank: {
          tokens: [
            { id: "whole", label: "He goes home" },
            { id: "distractor", label: "away" },
          ],
          separator: "space" as const,
          defaultMode: "bank" as const,
        },
      },
      {
        ...questions.find((question) => question.type === "sentenceTransformation")!,
        answerBank: {
          tokens: [
            { id: "whole", label: "Work starts at nine" },
            { id: "distractor", label: "ten" },
          ],
          separator: "space" as const,
          defaultMode: "bank" as const,
        },
      },
      {
        ...questions.find((question) => question.type === "dictation")!,
        transcript: "I drink water.",
        acceptedAnswers: ["I drink water."],
        answerBank: {
          tokens: [
            { id: "whole", label: "I drink water" },
            { id: "distractor", label: "tea" },
          ],
          separator: "space" as const,
          defaultMode: "bank" as const,
        },
      },
    ];

    deterministic.forEach((question) => {
      expect(() => lessonQuestionSchema.parse(question)).toThrow(/complete sentence answer/);
    });
  });

  it("keeps preview sentence banks composable without whole-answer tokens", () => {
    const japanese = createLocalPreviewLesson("unit-ja-banks", "Japanese", {
      ...DEFAULT_LEARNING_PROFILE,
      sourceLanguage: "English",
      targetLanguage: "Japanese",
      speakingEnabled: false,
      lessonQuestionCount: 15,
    });
    const normalize = (value: string) => value.normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, "");

    japanese.questions.forEach((question) => {
      if (!["translation", "errorCorrection", "sentenceTransformation", "freeWriting"].includes(question.type)) return;
      const bankLabels = question.answerBank?.tokens.map((token) => normalize(token.label)) ?? [];
      const completeAnswers = question.type === "translation"
        ? [question.referenceAnswer]
        : question.type === "errorCorrection" || question.type === "sentenceTransformation"
          ? question.acceptedAnswers
          : ["\u79c1\u306f\u6c34\u3092\u98f2\u307f\u307e\u3059\u3002"];
      completeAnswers.forEach((answer) => {
        expect(bankLabels).not.toContain(normalize(answer));
      });
    });
  });

  it("rejects CJK sentence coverage that only has a whole-sentence glossary entry", () => {
    const japaneseLesson = createLocalPreviewLesson("unit-ja", "Japanese schema", {
      ...DEFAULT_LEARNING_PROFILE,
      sourceLanguage: "English",
      targetLanguage: "Japanese",
      speakingEnabled: false,
      lessonQuestionCount: 15,
    });
    const lexicalTerms = new Set(["私", "は", "水", "を", "飲みます"]);

    expect(() => lessonSchema.parse({
      ...japaneseLesson,
      glossary: japaneseLesson.glossary.filter((entry) => !lexicalTerms.has(entry.term)),
    })).toThrow(/word- and particle-level entries/);
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

  it("moves skipped slots to the end and activates one alternate on skip four", () => {
    let state = createRetryState(["q1", "q2"]);
    for (let skip = 1; skip <= 3; skip += 1) {
      state = skipQuestion(state, "q1", true);
      expect(state.alternateQuestionIds).toEqual([]);
      state = skipQuestion(state, "q2", true);
    }
    state = skipQuestion(state, "q1", true);
    expect(state.queue).toEqual(["q2", "q1"]);
    expect(state.skipsByQuestion.q1).toBe(4);
    expect(state.alternateQuestionIds).toEqual(["q1"]);
    expect(state.attemptsByQuestion).toEqual({});
    expect(state.completed).toEqual([]);

    state = skipQuestion(state, "q1", true);
    expect(state.alternateQuestionIds.filter((id) => id === "q1")).toHaveLength(1);
  });

  it("switches a listening slot to its prepared alternate without counting a skip", () => {
    const state = useListeningAlternate(createRetryState(["dictation", "next"]), "dictation", true);
    expect(state.queue).toEqual(["next", "dictation"]);
    expect(state.alternateQuestionIds).toEqual(["dictation"]);
    expect(state.skipsByQuestion).toEqual({});
    expect(state.attemptsByQuestion).toEqual({});
  });
});

describe("profile and progress normalization", () => {
  it("inherits defaults and clamps unsafe values", () => {
    const profile = resolveLearningProfile({ targetLanguage: "Spanish", dailyQuestionGoal: 999 }, { speakingEnabled: false });
    expect(profile.targetLanguage).toBe("Spanish");
    expect(profile.sourceLanguage).toBe("English");
    expect(profile.dailyQuestionGoal).toBe(100);
    expect(profile.speakingEnabled).toBe(false);
    expect(profile.interfaceLanguage).toBe("en");
    expect(normalizeLearningProfile({ interfaceLanguage: "vi" }).interfaceLanguage).toBe("en");
    expect(normalizeLearningProfile({ lessonQuestionCount: 2 }).lessonQuestionCount).toBe(8);
    expect(normalizeLearningProfile({ preferredFormats: ["characterTracing", "singleChoice"] }).preferredFormats)
      .toEqual(["singleChoice"]);
    expect(detectBrowserLanguage(["vi-VN"])).toBe("Vietnamese");
    expect(detectBrowserLanguage(["pt-BR"])).toBe("English");
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

describe("collection question settings", () => {
  it("drops removed blueprint data and adds selectBlank when a collection inherits profile defaults", () => {
    const profile = normalizeLearningProfile({ preferredFormats: QUESTION_FORMATS.filter((format) => format !== "selectBlank") });
    const effective = getEffectiveCollectionQuestionSettings(undefined, profile);
    expect(effective.enabledFormats).toContain("selectBlank");
    expect(effective.enabledFormats).not.toContain("characterTracing");

    const normalized = normalizeCollectionQuestionSettings({
      enabledFormats: ["singleChoice", "translation", "unknown", "singleChoice"],
      customTemplates: [{ id: "template-1", name: "  My prompt  ", baseFormat: "singleChoice", guidance: "  Keep it short.  " }],
    });
    expect(normalized.enabledFormats).toEqual(["singleChoice", "translation"]);
    expect("customTemplates" in normalized).toBe(false);
    expect(normalizeCollectionQuestionSettings({
      enabledFormats: ["characterTracing", "singleChoice"],
      customTemplates: [{ id: "legacy-tracing", name: "Legacy", baseFormat: "characterTracing", guidance: "Trace." }],
    })).toMatchObject({
      enabledFormats: ["singleChoice"],
    });
  });

  it("validates enabled formats and builds generation constraints without blueprints", () => {
    const settings = normalizeCollectionQuestionSettings({
      enabledFormats: ["singleChoice", "trueFalse", "fillBlank", "translation", "shortAnswer"],
    });
    expect(validateCollectionQuestionSettings(settings, { ...DEFAULT_LEARNING_PROFILE, lessonQuestionCount: 8 })).toEqual([]);
    expect(buildQuestionGenerationConstraints(settings, DEFAULT_LEARNING_PROFILE)).toEqual({
      allowedFormats: ["singleChoice", "trueFalse", "fillBlank", "translation", "shortAnswer"],
    });
  });

  it("uses trusted format defaults instead of persisted presentation overrides", () => {
    const settings = normalizeCollectionQuestionSettings({
      enabledFormats: QUESTION_FORMATS,
      formatPresentation: { singleChoice: { readQuestion: true, readAnswers: true, wordTooltips: false } },
    });
    expect("formatPresentation" in settings).toBe(false);
    const lesson = createLocalPreviewLesson("decorate-unit", "Presentation", {
      ...DEFAULT_LEARNING_PROFILE,
      speakingEnabled: false,
    });
    const decorated = decorateLessonPresentation(lesson, settings, DEFAULT_LEARNING_PROFILE);
    expect(decorated.schemaVersion).toBe(7);
    expect(decorated.questions[0].presentation).toEqual({ readQuestion: false, readAnswers: false, wordTooltips: true });
  });
});

describe("glossary and speech preferences", () => {
  it("segments glossary phrases by longest match without producing HTML", () => {
    const segments = segmentGlossaryText("Good morning, morning class.", [
      { term: "morning", meaning: "the early part of a day" },
      { term: "good morning", meaning: "a morning greeting" },
    ]);
    expect(segments.filter((segment) => segment.entry).map((segment) => segment.entry?.term)).toEqual(["good morning", "morning"]);
    expect(segments.map((segment) => segment.text).join("")).toBe("Good morning, morning class.");
  });

  it("matches glossary terms inside languages that do not use whitespace boundaries", () => {
    const segments = segmentGlossaryText("私は朝ごはんを食べます。", [{ term: "朝ごはん", meaning: "breakfast" }]);
    expect(segments.find((segment) => segment.entry)?.text).toBe("朝ごはん");
  });

  it("segments CJK sentences lexically instead of letting a whole-sentence entry mask words and particles", () => {
    const sentence = "私は水を飲みます。";
    const segments = segmentGlossaryText(sentence, [
      { term: sentence, meaning: "I drink water.", forms: ["私は水を飲みます", "私"] },
      { term: "私", meaning: "I" },
      { term: "は", meaning: "topic marker" },
      { term: "水", meaning: "water" },
      { term: "を", meaning: "object marker" },
      { term: "飲みます", meaning: "drink" },
    ], { mode: "lexical-cjk" });

    expect(segments.filter((segment) => segment.entry).map((segment) => segment.text))
      .toEqual(["私", "は", "水", "を", "飲みます"]);
    expect(segments.some((segment) => segment.entry?.term === sentence)).toBe(false);
    expect(segments.map((segment) => segment.text).join("")).toBe(sentence);
  });

  it("clamps browser speech preferences and drops unsafe fields", () => {
    expect(normalizeSpeechPreference({ version: 99, voiceURI: "voice-1", rate: 9, autoplay: true })).toEqual({
      version: 1,
      voiceURI: "voice-1",
      rate: 2,
    });
    expect(normalizeSpeechPreference({ rate: 0.1 }).rate).toBe(0.25);
  });

  it("filters and resolves browser voices only within the target language", () => {
    const voices = [
      {
        default: true,
        lang: "en-US",
        localService: true,
        name: "English default",
        voiceURI: "voice-en",
      },
      {
        default: false,
        lang: "ja-JP",
        localService: true,
        name: "Japanese",
        voiceURI: "voice-ja",
      },
      {
        default: false,
        lang: "ja_JP",
        localService: true,
        name: "Japanese local",
        voiceURI: "voice-ja-local",
      },
    ] satisfies SpeechSynthesisVoice[];
    const matching = filterSpeechVoices(voices, "Japanese");
    expect(matching.map((voice) => voice.voiceURI)).toEqual(["voice-ja", "voice-ja-local"]);
    expect(resolveSpeechVoice(voices, { version: 1, voiceURI: "voice-en", rate: 1 }, "Japanese")?.voiceURI).toBe("voice-ja");
    expect(filterSpeechVoices(voices, "Unknown language")).toEqual([]);
    expect(voicePreviewSample("Japanese")).toBe("\u3053\u3093\u306b\u3061\u306f");
  });

  it("uses a pronunciation-equivalent fallback for Japanese hiragana vu", () => {
    expect(speechTextForLanguage("\u3094", "Japanese")).toBe("\u30f4");
    expect(speechTextForLanguage("\u3046\u3099", "ja-JP")).toBe("\u30f4");
    expect(speechTextForLanguage("\u3094", "English")).toBe("\u3094");
  });

  it("speaks only target-language spans identified by lesson metadata", () => {
    const question: LessonQuestion = {
      ...common,
      id: "speech-target",
      type: "singleChoice",
      prompt: "Choose \u6c34",
      options: [
        { id: "water", label: "\u6c34" },
        { id: "tea", label: "\u304a\u8336" },
      ],
      correctOptionId: "water",
      glossaryTargets: ["\u6c34", "\u304a\u8336"],
    };
    expect(questionSpeechText(question)).toBe("\u6c34");
    expect(answerSpeechText(question)).toBe("\u6c34. \u304a\u8336");
    expect(questionSpeechText(question)).not.toContain("Choose");
    expect(answerSpeechText(question)).not.toContain("Correction");
  });

  it("does not build automatic question speech for Audio Matching", () => {
    const question: LessonQuestion = {
      ...common,
      id: "audio-matching-speech",
      type: "audioMatching",
      prompt: "Match each sound.",
      pairs: [
        { audioId: "water-audio", audioText: "\u6c34", matchId: "water-meaning", label: "water" },
        { audioId: "tea-audio", audioText: "\u304a\u8336", matchId: "tea-meaning", label: "tea" },
      ],
      glossaryTargets: ["\u6c34", "\u304a\u8336"],
    };

    expect(questionSpeechText(question)).toBe("");
  });

  it("matches inflected aliases and retains multiple meanings and pronunciation", () => {
    const entry = {
      term: "drink",
      meaning: "consume a liquid",
      otherMeanings: ["an alcoholic beverage"],
      forms: ["drank"],
      aliases: ["beverage"],
      pronunciation: { native: "drink", romanized: "drink" },
    };
    const segments = segmentGlossaryText("She drank a beverage.", [entry]);
    expect(segments.filter((segment) => segment.entry).map((segment) => segment.text)).toEqual(["drank", "beverage"]);
    expect(segments.find((segment) => segment.entry)?.entry).toMatchObject({
      otherMeanings: ["an alcoholic beverage"],
      pronunciation: { romanized: "drink" },
    });
  });

  it("normalizes lesson-player overrides and clamps listening cooldown", () => {
    const now = 1_000;
    const normalized = normalizeLessonPlayerPreference({
      version: 99,
      readQuestion: true,
      readAnswers: "yes",
      wordTooltips: false,
      showPronunciation: false,
      pronunciationMode: "native",
      listeningDisabledUntil: now + LISTENING_PAUSE_DURATION_MS * 2,
      autoplay: true,
    }, now);
    expect(normalized).toEqual({
      version: 1,
      readQuestion: true,
      wordTooltips: false,
      showPronunciation: false,
      pronunciationMode: "native",
      listeningDisabledUntil: now + LISTENING_PAUSE_DURATION_MS,
      skipShortcut: DEFAULT_SKIP_SHORTCUT,
      typeaheadTimeoutMs: DEFAULT_TYPEAHEAD_TIMEOUT_MS,
    });
    expect(pauseListening(normalized, now).listeningDisabledUntil).toBe(now + LISTENING_PAUSE_DURATION_MS);
    expect(resetPresentationOverrides(normalized)).not.toHaveProperty("readQuestion");
    expect(resetLessonPlayerPreference(normalized)).toEqual({
      version: 1,
      showPronunciation: true,
      pronunciationMode: "romanized",
      listeningDisabledUntil: now + LISTENING_PAUSE_DURATION_MS,
      skipShortcut: DEFAULT_SKIP_SHORTCUT,
      typeaheadTimeoutMs: DEFAULT_TYPEAHEAD_TIMEOUT_MS,
    });
    expect(effectivePresentation(
      { readQuestion: false, readAnswers: true, wordTooltips: true },
      normalized,
    )).toEqual({ readQuestion: true, readAnswers: true, wordTooltips: false });
  });

  it("normalizes the browser-wide typeahead timeout to the supported quarter-second range", () => {
    expect(normalizeTypeaheadTimeoutMs(undefined)).toBe(1_500);
    expect(normalizeTypeaheadTimeoutMs(900)).toBe(1_000);
    expect(normalizeTypeaheadTimeoutMs(1_380)).toBe(1_500);
    expect(normalizeTypeaheadTimeoutMs(9_870)).toBe(9_750);
    expect(normalizeTypeaheadTimeoutMs(12_000)).toBe(10_000);
    expect(normalizeLessonPlayerPreference({ typeaheadTimeoutMs: 2_750 }).typeaheadTimeoutMs).toBe(2_750);
  });

  it("normalizes and matches safe lesson shortcuts", () => {
    expect(lessonShortcutLabel(DEFAULT_SKIP_SHORTCUT)).toBe("Alt+S");
    expect(lessonShortcutMatches({
      key: "S",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }, DEFAULT_SKIP_SHORTCUT)).toBe(true);
    expect(isForbiddenLessonShortcut({
      key: "Enter",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    })).toBe(true);
    expect(isForbiddenLessonShortcut({
      key: "l",
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    })).toBe(true);
    expect(normalizeLessonPlayerPreference({
      skipShortcut: {
        key: "k",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
      },
    }).skipShortcut).toEqual({
      key: "k",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    });
  });

  it("builds a schema-v7 language-pair demo with every active format and one alternate per slot", () => {
    const demo = createLocalPreviewLesson("unit-demo", "Demo", {
      ...DEFAULT_LEARNING_PROFILE,
      sourceLanguage: "Vietnamese",
      targetLanguage: "Japanese",
    });
    expect(demo.schemaVersion).toBe(7);
    expect(demo.sourceLanguage).toBe("Vietnamese");
    expect(demo.targetLanguage).toBe("Japanese");
    expect(demo.title).toContain("Bài học mẫu");
    expect(demo.questions.some((question) => question.glossaryTargets?.includes("水"))).toBe(true);
    expect(demo.glossary.find((entry) => entry.term === "水")?.meaning).toBe("nước");
    expect(demo.glossary.find((entry) => entry.term === "飲みます")?.meaning).toBe("uống");
    expect(demo.questions).toHaveLength(23);
    expect(new Set(demo.questions.map((question) => question.type))).toEqual(new Set(LESSON_QUESTION_FORMATS));
    expect(demo.questionAlternates).toHaveLength(23);
    expect(() => lessonSchema.parse(demo)).not.toThrow();
    expect(() => lessonSchema.parse({ ...demo, schemaVersion: 6 })).toThrow();
    expect(parseLessonProgressSnapshot({
      lessonId: demo.id,
      completedQuestionIds: demo.questions.map((question) => question.id),
      attemptsByQuestion: Object.fromEntries(demo.questions.map((question) => [question.id, 1])),
      firstTryCorrect: 23,
      totalQuestions: 23,
      masteryPercent: 100,
      updatedAt: "2026-07-22T00:00:00.000Z",
    }).totalQuestions).toBe(23);
    expect(() => parseLessonProgressSnapshot({
      lessonId: "too-many",
      completedQuestionIds: Array.from({ length: 24 }, (_, index) => `old-${index}`),
      attemptsByQuestion: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`old-${index}`, 1])),
      firstTryCorrect: 24,
      totalQuestions: 24,
      masteryPercent: 100,
      updatedAt: "2026-07-22T00:00:00.000Z",
    })).toThrow();
  });
});
