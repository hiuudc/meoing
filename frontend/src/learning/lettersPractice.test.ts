import { describe, expect, it } from "vitest";
import {
  buildLettersPracticeSession,
  selectLettersPracticeCharacters,
  type LettersCharacterMetadata,
} from "./lettersPractice";
import type { LetterProgressStatus } from "./letters";

const characters = ["あ", "い", "う", "え", "お", "か"];
const metadata = new Map<string, LettersCharacterMetadata>([
  ["あ", { reading: "a" }],
  ["い", { reading: "i" }],
  ["う", { reading: "u" }],
  ["え", { reading: "e" }],
  ["お", { reading: "o" }],
  ["か", { reading: "ka" }],
]);
const progress: Record<string, LetterProgressStatus> = {
  "あ": "mastered",
  "い": "practicing",
};

function build(questionCount?: number) {
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
    questionCount,
    sessionId: "letters-session",
    createdAt: "2026-07-26T00:00:00.000Z",
  });
}

describe("Letters practice sessions", () => {
  it("builds a five-question local session by default and prioritizes unfinished characters", () => {
    expect(selectLettersPracticeCharacters(characters, progress)).toEqual(["い", "う", "え"]);

    const session = build();
    expect(session.targetCharacters).toEqual(["い", "う", "え"]);
    expect(session.lesson.questions).toHaveLength(5);
    expect(session.lesson.questions.map((question) => question.type)).toEqual([
      "characterTracing",
      "listenSelect",
      "singleChoice",
      "singleChoice",
      "audioMatching",
    ]);
    expect(session.lesson.questions.every((question) => question.evaluationMode === "local")).toBe(true);
    expect(session.lesson.questionAlternates.map((alternate) => alternate.question.type)).toEqual([
      "singleChoice",
      "matching",
    ]);
    expect(session.lesson.summary).toContain("5 local exercises");
  });

  it("uses the custom bounded question count and maps completion back to each character", () => {
    const shortSession = build(1);
    expect(shortSession.lesson.questions).toHaveLength(1);
    expect(shortSession.targetCharacters).toEqual(["い"]);
    expect(shortSession.questionIdsByCharacter["い"]).toEqual([
      shortSession.lesson.questions[0].id,
    ]);

    const longSession = build(99);
    expect(longSession.lesson.questions).toHaveLength(20);
    expect(longSession.targetCharacters).toHaveLength(5);
    longSession.targetCharacters.forEach((character) => {
      expect(longSession.questionIdsByCharacter[character].length).toBeGreaterThan(0);
    });
  });

  it("keeps tracing local to the playable lesson instead of adding it to generated lesson validation", () => {
    const session = build();
    const tracing = session.lesson.questions[0];
    expect(tracing).toMatchObject({
      type: "characterTracing",
      character: "い",
      requireStrokeOrder: true,
      evaluationMode: "local",
    });
    expect(session.lesson.unitId).toBe("letters:collection-a:hiragana");
  });
});
