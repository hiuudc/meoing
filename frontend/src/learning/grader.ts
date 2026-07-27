import type {
  AiGradeRequest,
  EvaluationStatus,
  GradeResult,
  LocalGradeResult,
  PlayableQuestion,
  QuestionAnswer,
  TextMatchOptions,
} from "./types";

const punctuationPattern = /[\p{P}\p{S}]/gu;
const diacriticPattern = /\p{M}/gu;

export interface GradeContext {
  inputMode?: "keyboard" | "bank";
}

export function normalizeAnswer(value: string, options: TextMatchOptions = {}): string {
  let normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (options.ignorePunctuation) normalized = normalized.replace(punctuationPattern, "").replace(/\s+/g, " ").trim();
  if (options.ignoreDiacritics) normalized = normalized.normalize("NFD").replace(diacriticPattern, "");
  return options.caseSensitive ? normalized : normalized.toLocaleLowerCase();
}

export function normalizeBankAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function asString(answer: QuestionAnswer): string {
  return typeof answer === "string" ? answer : "";
}

function asStrings(answer: QuestionAnswer): string[] {
  return Array.isArray(answer) ? answer : [];
}

function asMap(answer: QuestionAnswer): Record<string, string> {
  return answer && typeof answer === "object" && !Array.isArray(answer) ? answer : {};
}

function matchesAccepted(answer: string, accepted: string[], options?: TextMatchOptions): boolean {
  const normalized = normalizeAnswer(answer, options);
  return accepted.some((candidate) => normalizeAnswer(candidate, options) === normalized);
}

function statusFromScore(score: number): EvaluationStatus {
  if (score >= 1) return "correct";
  if (score > 0) return "partial";
  return "incorrect";
}

function localResult(
  question: PlayableQuestion,
  score: number,
  correction: string,
  errorMessage = "The answer does not match the answer key.",
): LocalGradeResult {
  const bounded = Math.max(0, Math.min(1, score));
  const status = statusFromScore(bounded);
  return {
    requiresAi: false,
    status,
    score: bounded,
    correctParts: status === "correct" ? ["Complete answer"] : bounded > 0 ? ["Part of the answer"] : [],
    errors: status === "correct" ? [] : [{ location: "answer", message: errorMessage }],
    correction,
    explanation: status === "correct" ? question.explanation : `${errorMessage} ${question.explanation}`,
    nextHint: status === "correct" ? "Continue to the next question." : question.hint ?? "Review the related theory and try again.",
  };
}

function compareOrdered(actual: string[], expected: string[]): number {
  if (!expected.length) return 0;
  let correct = 0;
  expected.forEach((value, index) => {
    if (actual[index] === value) correct += 1;
  });
  return correct / expected.length;
}

function compareSet(actual: string[], expected: string[]): number {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const selectedCorrect = [...actualSet].filter((value) => expectedSet.has(value)).length;
  const falseSelections = [...actualSet].filter((value) => !expectedSet.has(value)).length;
  return Math.max(0, (selectedCorrect - falseSelections) / Math.max(1, expectedSet.size));
}

function ai(reason: AiGradeRequest["reason"]): AiGradeRequest {
  return { requiresAi: true, reason };
}

export function gradeAnswer(
  question: PlayableQuestion,
  answer: QuestionAnswer,
  context: GradeContext = {},
): GradeResult {
  switch (question.type) {
    case "singleChoice": {
      const actual = asString(answer);
      const expected = question.options.find((option) => option.id === question.correctOptionId)?.label ?? question.correctOptionId;
      return localResult(question, actual === question.correctOptionId ? 1 : 0, expected);
    }
    case "multipleChoice": {
      const score = compareSet(asStrings(answer), question.correctOptionIds);
      const correction = question.options.filter((option) => question.correctOptionIds.includes(option.id)).map((option) => option.label).join(", ");
      return localResult(question, score, correction, "Select every correct answer and remove any extra choices.");
    }
    case "trueFalse":
      return localResult(question, typeof answer === "boolean" && answer === question.correct ? 1 : 0, question.correct ? "True" : "False");
    case "fillBlank":
      return localResult(question, matchesAccepted(asString(answer), question.acceptedAnswers, question.match) ? 1 : 0, question.acceptedAnswers[0]);
    case "selectBlank": {
      const actual = asString(answer);
      const expected = question.options.find((option) => option.id === question.correctOptionId)?.label ?? question.correctOptionId;
      return localResult(question, actual === question.correctOptionId ? 1 : 0, expected);
    }
    case "multiCloze": {
      const answers = asMap(answer);
      const correct = question.blanks.filter((blank) => matchesAccepted(answers[blank.id] ?? "", blank.acceptedAnswers, question.match)).length;
      return localResult(question, correct / question.blanks.length, question.blanks.map((blank) => blank.acceptedAnswers[0]).join(" · "), "One or more blanks are incorrect.");
    }
    case "wordBank": {
      const score = compareOrdered(asStrings(answer), question.correctOrderIds);
      const labels = new Map(question.tokens.map((token) => [token.id, token.label]));
      return localResult(question, score, question.correctOrderIds.map((id) => labels.get(id) ?? id).join(" "), "The word order is not complete.");
    }
    case "matching": {
      const answers = asMap(answer);
      const correct = question.pairs.filter((pair) => answers[pair.leftId] === pair.rightId).length;
      return localResult(question, correct / question.pairs.length, question.pairs.map((pair) => `${pair.left} → ${pair.right}`).join("; "), "One or more pairs do not match.");
    }
    case "reorderTokens": {
      const score = compareOrdered(asStrings(answer), question.correctOrderIds);
      const labels = new Map(question.tokens.map((token) => [token.id, token.label]));
      return localResult(question, score, question.correctOrderIds.map((id) => labels.get(id) ?? id).join(" "), "The tokens are not in the correct order.");
    }
    case "reorderDialogue": {
      const score = compareOrdered(asStrings(answer), question.correctOrderIds);
      const turns = new Map(question.turns.map((turn) => [turn.id, `${turn.speaker}: ${turn.label}`]));
      return localResult(question, score, question.correctOrderIds.map((id) => turns.get(id) ?? id).join(" → "), "The dialogue turns are not in the correct order.");
    }
    case "categorize": {
      const answers = asMap(answer);
      const correct = question.items.filter((item) => answers[item.id] === item.categoryId).length;
      const categories = new Map(question.categories.map((category) => [category.id, category.label]));
      return localResult(question, correct / question.items.length, question.items.map((item) => `${item.label} → ${categories.get(item.categoryId) ?? item.categoryId}`).join("; "), "One or more items are in the wrong category.");
    }
    case "translation":
    case "shortAnswer":
      if (context.inputMode === "bank") {
        return localResult(
          question,
          normalizeBankAnswer(asString(answer)) === normalizeBankAnswer(question.referenceAnswer) ? 1 : 0,
          question.referenceAnswer,
          "The selected words do not match the reference answer or its order.",
        );
      }
      return ai("semantic");
    case "errorCorrection":
      return localResult(question, matchesAccepted(asString(answer), question.acceptedAnswers, question.match) ? 1 : 0, question.acceptedAnswers[0]);
    case "sentenceTransformation":
      return localResult(question, matchesAccepted(asString(answer), question.acceptedAnswers, question.match) ? 1 : 0, question.acceptedAnswers[0]);
    case "dictation":
      return localResult(question, matchesAccepted(asString(answer), question.acceptedAnswers, question.match) ? 1 : 0, question.acceptedAnswers[0]);
    case "freeWriting":
      return ai("writing");
    case "speakingRepeat":
    case "speakingRoleplay":
      return ai("speaking");
    case "listenSelect":
    case "soundDiscrimination": {
      const actual = asString(answer);
      const expected = question.options.find((option) => option.id === question.correctOptionId)?.label
        ?? question.correctOptionId;
      return localResult(question, actual === question.correctOptionId ? 1 : 0, expected);
    }
    case "audioMatching": {
      const answers = asMap(answer);
      const correct = question.pairs.filter((pair) => answers[pair.audioId] === pair.matchId).length;
      return localResult(
        question,
        correct / question.pairs.length,
        question.pairs.map((pair) => `${pair.audioText} -> ${pair.label}`).join("; "),
        "One or more audio pairs do not match.",
      );
    }
    case "flashcardRecall":
      return localResult(
        question,
        matchesAccepted(asString(answer), question.acceptedAnswers, question.match) ? 1 : 0,
        question.acceptedAnswers[0],
      );
    case "characterTracing":
      return localResult(
        question,
        asString(answer) === "passed" ? 1 : 0,
        question.character,
        "Complete the character trace before checking the answer.",
      );
  }
}

export function isAnswerEmpty(answer: QuestionAnswer): boolean {
  if (typeof answer === "string") return !answer.trim();
  if (typeof answer === "boolean") return false;
  if (Array.isArray(answer)) return answer.length === 0;
  return Object.keys(answer).length === 0 || Object.values(answer).some((value) => !value.trim());
}

export function isAnswerComplete(question: PlayableQuestion, answer: QuestionAnswer): boolean {
  if (isAnswerEmpty(answer)) return false;
  if (question.type === "multiCloze") {
    const values = asMap(answer);
    return question.blanks.every((blank) => Boolean(values[blank.id]?.trim()));
  }
  if (question.type === "matching") {
    const values = asMap(answer);
    return question.pairs.every((pair) => values[pair.leftId] === pair.rightId);
  }
  if (question.type === "audioMatching") {
    const values = asMap(answer);
    return question.pairs.every((pair) => values[pair.audioId] === pair.matchId);
  }
  if (question.type === "categorize") {
    const values = asMap(answer);
    return question.items.every((item) => values[item.id] === item.categoryId);
  }
  if (question.type === "characterTracing") return asString(answer) === "passed";
  return true;
}
