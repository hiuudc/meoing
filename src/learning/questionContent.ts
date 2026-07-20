import type { Evaluation, LessonQuestion } from "./types";

export function questionSpeechText(question: LessonQuestion): string {
  const parts = [question.prompt];
  switch (question.type) {
    case "trueFalse": parts.push(question.statement); break;
    case "fillBlank": parts.push(question.template.replace(/_+/g, " blank ")); break;
    case "selectBlank": parts.push(question.template.replace("{{blank}}", " blank ")); break;
    case "multiCloze": parts.push(question.template.replace(/_+/g, " blank ")); break;
    case "translation": parts.push(question.sourceText); break;
    case "errorCorrection": parts.push(question.incorrectText); break;
    case "sentenceTransformation": parts.push(question.sourceText, question.constraint); break;
    case "dictation": parts.push(question.transcript); break;
    case "speakingRepeat": parts.push(question.modelText); break;
    case "speakingRoleplay": parts.push(question.role, question.scenario, question.goal); break;
  }
  return parts.filter(Boolean).join(". ");
}

export function answerSpeechText(question: LessonQuestion, evaluation?: Evaluation | null): string {
  const parts: string[] = [];
  switch (question.type) {
    case "singleChoice":
    case "multipleChoice":
    case "selectBlank":
      parts.push(...question.options.map((option) => option.label));
      break;
    case "trueFalse": parts.push("True", "False"); break;
    case "wordBank":
    case "reorderTokens": parts.push(...question.tokens.map((token) => token.label)); break;
    case "matching": parts.push(...question.pairs.flatMap((pair) => [pair.left, pair.right])); break;
    case "reorderDialogue": parts.push(...question.turns.map((turn) => `${turn.speaker}: ${turn.label}`)); break;
    case "categorize": parts.push(...question.categories.map((category) => category.label), ...question.items.map((item) => item.label)); break;
  }
  if (evaluation?.correction) parts.push(`Correction: ${evaluation.correction}`);
  return parts.join(". ");
}
