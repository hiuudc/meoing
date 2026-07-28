import { describe, expect, it } from "vitest";
import {
  buildLettersPracticeSession,
  lettersPracticeExerciseCount,
  selectLettersPracticeCharacters,
  type LettersCharacterMetadata,
} from "./lettersPractice";
import type { LetterProgressStatus } from "./letters";

const characters = ["\u3042", "\u3044", "\u3046", "\u3048", "\u304a", "\u304b"];
const metadata = new Map<string, LettersCharacterMetadata>([
  ["\u3042", { reading: "a" }],
  ["\u3044", { reading: "i" }],
  ["\u3046", { reading: "u" }],
  ["\u3048", { reading: "e" }],
  ["\u304a", { reading: "o" }],
  ["\u304b", { reading: "ka" }],
]);
const progress: Record<string, LetterProgressStatus> = {
  "\u3042": "mastered",
  "\u3044": "practicing",
};

function build(characterCount?: number) {
  return buildLettersPracticeSession({
    collectionId: "collection-a",
    language: "Japanese",
    sourceLanguage: "English",
    level: "beginner",
    script: "hiragana",
    scriptLabel: "Hiragana",
    characters,
    metadata,
    progress,
    requireStrokeOrder: true,
    characterCount,
    sessionId: "letters-session",
    createdAt: "2026-07-26T00:00:00.000Z",
  });
}

describe("Letters practice sessions", () => {
  it("selects five characters by default and gives every target all five exercise forms", () => {
    expect(selectLettersPracticeCharacters(characters, progress)).toEqual([
      "\u3044",
      "\u3046",
      "\u3048",
      "\u304a",
      "\u304b",
    ]);

    const session = build();
    expect(session.targetCharacters).toHaveLength(5);
    expect(session.lesson.questions).toHaveLength(lettersPracticeExerciseCount(5));
    expect(session.lesson.questions).toHaveLength(21);
    expect(session.lesson.summary).toContain("21 local exercises for 5 characters");
    expect(session.lesson.questions.every((question) => question.evaluationMode === "local")).toBe(true);

    const questionsById = new Map(session.lesson.questions.map((question) => [question.id, question]));
    session.targetCharacters.forEach((character) => {
      const related = session.questionIdsByCharacter[character].map((id) => questionsById.get(id)?.type);
      expect(related).toEqual([
        "characterTracing",
        "listenSelect",
        "singleChoice",
        "singleChoice",
        "audioMatching",
      ]);
    });
  });

  it("asks for a reading without repeating the target glyph as its own answer", () => {
    const session = build(1);
    const visual = session.lesson.questions.find((question) => (
      question.type === "singleChoice" && Boolean(question.targetPrompt)
    ));
    const descriptor = session.lesson.questions.find((question) => (
      question.type === "singleChoice" && !question.targetPrompt
    ));
    const listening = session.lesson.questions.find((question) => question.type === "listenSelect");

    expect(visual).toMatchObject({
      type: "singleChoice",
      prompt: "Select the correct name or reading.",
      targetPrompt: "\u3044",
      glossaryTargets: ["\u3044"],
      correctOptionId: "character-3044",
    });
    if (visual?.type !== "singleChoice") throw new Error("Visual reading question not found.");
    expect(visual.options.map((option) => option.label)).not.toContain("\u3044");
    expect(visual.options.find((option) => option.id === visual.correctOptionId)?.label).toBe("i");

    if (descriptor?.type !== "singleChoice") throw new Error("Descriptor question not found.");
    expect(descriptor.glossaryTargets).toEqual(descriptor.options.map((option) => option.label));
    if (listening?.type !== "listenSelect") throw new Error("Listening question not found.");
    expect(listening.glossaryTargets).toEqual(listening.options.map((option) => option.label));

    const matchingAlternate = session.lesson.questionAlternates
      .map((alternate) => alternate.question)
      .find((question) => question.type === "matching");
    expect(matchingAlternate?.glossaryTargets).toEqual(
      matchingAlternate?.type === "matching"
        ? matchingAlternate.pairs.map((pair) => pair.right)
        : [],
    );
  });

  it("clamps the custom character count and splits matching into groups of five", () => {
    const manyCharacters = Array.from({ length: 12 }, (_, index) => String.fromCodePoint(0x4e00 + index));
    const session = buildLettersPracticeSession({
      collectionId: "collection-a",
      language: "Japanese",
      sourceLanguage: "English",
      level: "beginner",
      script: "kanji",
      scriptLabel: "Kanji",
      characters: manyCharacters,
      metadata: new Map(),
      progress: {},
      requireStrokeOrder: true,
      characterCount: 99,
      sessionId: "long-letters-session",
      createdAt: "2026-07-26T00:00:00.000Z",
    });

    expect(session.targetCharacters).toHaveLength(10);
    expect(session.lesson.questions).toHaveLength(42);
    expect(session.lesson.questions.filter((question) => question.type === "audioMatching")).toHaveLength(2);
    expect(session.questionIdsByCharacter[manyCharacters[0]]).toHaveLength(5);
    expect(session.questionIdsByCharacter[manyCharacters[9]]).toHaveLength(5);
    expect(lettersPracticeExerciseCount(1)).toBe(5);
    expect(lettersPracticeExerciseCount(10)).toBe(42);
  });

  it("keeps small and regular kana families out of the same session when alternatives exist", () => {
    const kana = ["\u3043", "\u3044", "\u3046", "\u3048", "\u304a", "\u304b"];
    const selected = selectLettersPracticeCharacters(kana, {}, 5);
    expect(selected).toEqual(["\u3043", "\u3046", "\u3048", "\u304a", "\u304b"]);

    const session = buildLettersPracticeSession({
      collectionId: "collection-a",
      language: "Japanese",
      sourceLanguage: "English",
      level: "beginner",
      script: "hiragana",
      scriptLabel: "Hiragana",
      characters: kana,
      metadata: new Map([
        ["\u3043", { displayLabel: "small i", reading: "i" }],
        ["\u3044", { reading: "i" }],
      ]),
      progress: {},
      requireStrokeOrder: true,
      characterCount: 5,
      sessionId: "family-session",
      createdAt: "2026-07-26T00:00:00.000Z",
    });
    const optionLabels = session.lesson.questions.flatMap((question) => (
      "options" in question ? question.options.map((option) => option.label) : []
    ));

    expect(session.targetCharacters).not.toContain("\u3044");
    expect(optionLabels).not.toContain("\u3044");
    expect(selectLettersPracticeCharacters(["\u3043", "\u3044"], {}, 2))
      .toEqual(["\u3043", "\u3044"]);
  });

  it("excludes every Hiragana and Katakana sibling family from targets and distractors", () => {
    const pairs = [
      [0x3041, 0x3042],
      [0x3043, 0x3044],
      [0x3045, 0x3046],
      [0x3047, 0x3048],
      [0x3049, 0x304a],
      [0x3063, 0x3064],
      [0x3083, 0x3084],
      [0x3085, 0x3086],
      [0x3087, 0x3088],
      [0x308e, 0x308f],
      [0x3095, 0x304b],
      [0x3096, 0x3051],
    ] as const;
    const hiraganaAlternatives = ["\u305d", "\u306a", "\u307b", "\u3093"];

    for (const offset of [0, 0x60]) {
      for (const [smallCodePoint, regularCodePoint] of pairs) {
        const small = String.fromCodePoint(smallCodePoint + offset);
        const regular = String.fromCodePoint(regularCodePoint + offset);
        const alternatives = hiraganaAlternatives.map((character) => (
          String.fromCodePoint(character.codePointAt(0)! + offset)
        ));
        const sessionCharacters = [small, regular, ...alternatives];
        const session = buildLettersPracticeSession({
          collectionId: "collection-a",
          language: "Japanese",
          sourceLanguage: "English",
          level: "beginner",
          script: offset ? "katakana" : "hiragana",
          scriptLabel: offset ? "Katakana" : "Hiragana",
          characters: sessionCharacters,
          metadata: new Map(),
          progress: {},
          requireStrokeOrder: true,
          characterCount: 5,
          sessionId: `family-${smallCodePoint}-${offset}`,
          createdAt: "2026-07-26T00:00:00.000Z",
        });
        const optionLabels = session.lesson.questions.flatMap((question) => (
          "options" in question ? question.options.map((option) => option.label) : []
        ));

        expect(session.targetCharacters).toContain(small);
        expect(session.targetCharacters).not.toContain(regular);
        expect(optionLabels).not.toContain(regular);
      }
    }
  });

  it("keeps tracing local to the playable lesson instead of generated lesson validation", () => {
    const session = build(1);
    const tracing = session.lesson.questions[0];
    expect(tracing).toMatchObject({
      type: "characterTracing",
      character: "\u3044",
      requireStrokeOrder: true,
      evaluationMode: "local",
    });
    expect(session.lesson.unitId).toBe("letters:collection-a:hiragana");
  });

  it("distinguishes small kana in display text while preserving pronunciation", () => {
    const kana = ["\u3041", "\u3042"];
    const kanaMetadata = new Map<string, LettersCharacterMetadata>([
      ["\u3041", { displayLabel: "small a", reading: "a" }],
      ["\u3042", { reading: "a" }],
    ]);
    const session = buildLettersPracticeSession({
      collectionId: "collection-a",
      language: "Japanese",
      sourceLanguage: "English",
      level: "beginner",
      script: "hiragana",
      scriptLabel: "Hiragana",
      characters: kana,
      metadata: kanaMetadata,
      progress: {},
      requireStrokeOrder: true,
      characterCount: 2,
      sessionId: "small-kana-session",
      createdAt: "2026-07-26T00:00:00.000Z",
    });

    expect(session.lesson.questions[0]).toMatchObject({
      type: "characterTracing",
      character: "\u3041",
      reading: "small a",
    });
    expect(session.lesson.examples.map((example) => example.translation)).toEqual(["small a", "a"]);
    expect(session.lesson.glossary.map((entry) => entry.pronunciation?.romanized)).toEqual(["a", "a"]);
  });
});
