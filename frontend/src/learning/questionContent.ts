import type { Evaluation, LessonQuestion } from "./types";

function uniqueSpeechParts(parts: string[]): string[] {
  return [...new Set(parts.map((part) => (
    part
      .replace(/\{\{blank\}\}/g, " ")
      .replace(/_{2,}/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )).filter(Boolean))];
}

function targetPartsIn(question: LessonQuestion, candidates: string[]): string[] {
  if (!question.glossaryTargets?.length) return [];
  return uniqueSpeechParts(question.glossaryTargets.filter((target) => (
    candidates.some((candidate) => candidate.includes(target))
  )));
}

function questionTextCandidates(question: LessonQuestion): string[] {
  const parts = [question.prompt];
  switch (question.type) {
    case "trueFalse": parts.push(question.statement); break;
    case "fillBlank":
    case "selectBlank":
    case "multiCloze": parts.push(question.template); break;
    case "translation": parts.push(question.sourceText); break;
    case "errorCorrection": parts.push(question.incorrectText); break;
    case "sentenceTransformation": parts.push(question.sourceText, question.constraint); break;
    case "dictation": parts.push(question.transcript); break;
    case "speakingRepeat": parts.push(question.modelText); break;
    case "speakingRoleplay": parts.push(question.role, question.scenario, question.goal); break;
  }
  return parts;
}

function answerTextCandidates(question: LessonQuestion, evaluation?: Evaluation | null): string[] {
  const parts: string[] = [];
  switch (question.type) {
    case "singleChoice":
    case "multipleChoice":
    case "selectBlank":
      parts.push(...question.options.map((option) => option.label));
      break;
    case "wordBank":
    case "reorderTokens":
      parts.push(...question.tokens.map((token) => token.label));
      break;
    case "matching":
      parts.push(...question.pairs.flatMap((pair) => [pair.left, pair.right]));
      break;
    case "reorderDialogue":
      parts.push(...question.turns.flatMap((turn) => [turn.speaker, turn.label]));
      break;
    case "categorize":
      parts.push(
        ...question.categories.map((category) => category.label),
        ...question.items.map((item) => item.label),
      );
      break;
    case "freeWriting":
      parts.push(...(question.supportBank ?? []).map((token) => token.label));
      break;
  }
  if (evaluation?.correction) parts.push(evaluation.correction);
  return parts;
}

export function questionVisibleTexts(question: LessonQuestion): string[] {
  const parts = [question.prompt];
  switch (question.type) {
    case "singleChoice":
    case "multipleChoice":
    case "selectBlank":
      parts.push(...question.options.map((option) => option.label));
      if (question.type === "selectBlank") parts.push(question.template.replace("{{blank}}", ""));
      break;
    case "trueFalse": parts.push(question.statement); break;
    case "fillBlank": parts.push(question.template); break;
    case "multiCloze": parts.push(question.template); break;
    case "wordBank":
    case "reorderTokens": parts.push(...question.tokens.map((token) => token.label)); break;
    case "matching": parts.push(...question.pairs.flatMap((pair) => [pair.left, pair.right])); break;
    case "reorderDialogue": parts.push(...question.turns.flatMap((turn) => [turn.speaker, turn.label])); break;
    case "categorize": parts.push(
      ...question.categories.map((category) => category.label),
      ...question.items.map((item) => item.label),
    ); break;
    case "translation": parts.push(question.sourceText); break;
    case "errorCorrection": parts.push(question.incorrectText); break;
    case "sentenceTransformation": parts.push(question.sourceText, question.constraint); break;
    case "dictation": parts.push(question.transcript); break;
    case "freeWriting": parts.push(...(question.supportBank ?? []).map((token) => token.label)); break;
    case "speakingRepeat": parts.push(question.modelText); break;
    case "speakingRoleplay": parts.push(question.role, question.scenario, question.goal); break;
    case "shortAnswer": break;
  }
  return parts.filter((part) => part.trim().length > 0);
}

export function questionSpeechText(question: LessonQuestion): string {
  const targetParts = targetPartsIn(question, questionTextCandidates(question));
  if (targetParts.length) return targetParts.join(". ");

  // Legacy lessons do not identify target-language spans. Only use fields whose
  // format guarantees that the stored text is in the language being learned.
  if (question.type === "dictation") return question.transcript;
  if (question.type === "speakingRepeat") return question.modelText;
  return "";
}

export function answerSpeechText(question: LessonQuestion, evaluation?: Evaluation | null): string {
  const targetParts = targetPartsIn(question, answerTextCandidates(question, evaluation));
  if (targetParts.length) return targetParts.join(". ");

  // A translation reference answer explicitly uses the question's target
  // language and is safe to reveal only after the answer has been evaluated.
  if (evaluation && question.type === "translation") {
    return question.referenceAnswer;
  }
  return "";
}

export function answerActivationSpeechText(question: LessonQuestion, activatedText: string): string {
  return targetPartsIn(question, [activatedText]).join(". ");
}
