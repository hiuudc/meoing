import type { Evaluation, PlayableQuestion } from "./types";
import { stripBlankMarkers } from "./multiCloze";

function uniqueSpeechParts(parts: string[]): string[] {
  return [...new Set(parts.map((part) => (
    part
      .replace(/\{\{blank(?::[^{}]+)?\}\}/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  )).filter(Boolean))];
}

function targetPartsIn(question: PlayableQuestion, candidates: string[]): string[] {
  if (!question.glossaryTargets?.length) return [];
  return uniqueSpeechParts(question.glossaryTargets.filter((target) => (
    candidates.some((candidate) => candidate.includes(target))
  )));
}

function questionTextCandidates(question: PlayableQuestion): string[] {
  const parts = [question.prompt];
  if (question.targetPrompt) parts.push(question.targetPrompt);
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
    case "listenSelect":
    case "soundDiscrimination": parts.push(question.audioText); break;
    case "audioMatching": parts.push(...question.pairs.map((pair) => pair.audioText)); break;
    case "flashcardRecall": parts.push(question.cue); break;
    case "characterTracing": parts.push(question.character); break;
  }
  return parts;
}

function answerTextCandidates(question: PlayableQuestion, evaluation?: Evaluation | null): string[] {
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
    case "listenSelect":
    case "soundDiscrimination":
      parts.push(...question.options.map((option) => option.label));
      break;
    case "audioMatching":
      parts.push(...question.pairs.flatMap((pair) => [pair.audioText, pair.label]));
      break;
  }
  parts.push(...(question.answerBank?.tokens ?? []).map((token) => token.label));
  if (evaluation?.correction) parts.push(evaluation.correction);
  return parts;
}

export function questionVisibleTexts(question: PlayableQuestion): string[] {
  const parts = [question.prompt];
  if (question.targetPrompt) parts.push(question.targetPrompt);
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
    case "listenSelect":
    case "soundDiscrimination":
      parts.push(question.audioText, ...question.options.map((option) => option.label));
      break;
    case "audioMatching":
      parts.push(...question.pairs.flatMap((pair) => [pair.audioText, pair.label]));
      break;
    case "flashcardRecall": parts.push(question.cue); break;
    case "characterTracing":
      parts.push(question.character);
      if (question.meaning) parts.push(question.meaning);
      if (question.reading) parts.push(question.reading);
      break;
    case "shortAnswer": break;
  }
  parts.push(...(question.answerBank?.tokens ?? []).map((token) => token.label));
  return parts.filter((part) => part.trim().length > 0);
}

export function questionSpeechText(question: PlayableQuestion): string {
  if (question.type === "audioMatching") return "";
  if (question.targetPrompt?.trim()) return stripBlankMarkers(question.targetPrompt);
  const targetParts = targetPartsIn(question, questionTextCandidates(question));
  if (targetParts.length) return targetParts.join(". ");

  if (question.type === "dictation") return question.transcript;
  if (question.type === "listenSelect" || question.type === "soundDiscrimination") return question.audioText;
  if (question.type === "speakingRepeat") return question.modelText;
  return "";
}

export function targetPromptSpeechText(question: PlayableQuestion): string {
  return question.targetPrompt ? stripBlankMarkers(question.targetPrompt) : "";
}

export function answerSpeechText(question: PlayableQuestion, evaluation?: Evaluation | null): string {
  const targetParts = targetPartsIn(question, answerTextCandidates(question, evaluation));
  if (targetParts.length) return targetParts.join(". ");

  // A translation reference answer explicitly uses the question's target
  // language and is safe to reveal only after the answer has been evaluated.
  if (evaluation && question.type === "translation") {
    return question.referenceAnswer;
  }
  return "";
}

export function answerActivationSpeechText(question: PlayableQuestion, activatedText: string): string {
  return targetPartsIn(question, [activatedText]).join(". ");
}
