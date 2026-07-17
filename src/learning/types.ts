export const QUESTION_FORMATS = [
  "singleChoice",
  "multipleChoice",
  "trueFalse",
  "fillBlank",
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
] as const;

export type QuestionFormat = (typeof QUESTION_FORMATS)[number];
export type EvaluationStatus = "correct" | "partial" | "incorrect";
export type EvaluationMode = "local" | "ai";

export interface LearningProfile {
  targetLanguage: string;
  interfaceLanguage: "vi" | "en";
  level: "beginner" | "elementary" | "intermediate" | "upperIntermediate" | "advanced";
  dailyQuestionGoal: number;
  lessonQuestionCount: number;
  speakingEnabled: boolean;
  preferredFormats: QuestionFormat[];
  coachingStyle: "gentle" | "direct" | "socratic";
}

export interface TextMatchOptions {
  caseSensitive?: boolean;
  ignoreDiacritics?: boolean;
  ignorePunctuation?: boolean;
}

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface BaseQuestion {
  id: string;
  type: QuestionFormat;
  prompt: string;
  explanation: string;
  hint?: string;
  supplementalHint?: string;
  sourceReferenceIds?: string[];
  evaluationMode: EvaluationMode;
}

export interface SingleChoiceQuestion extends BaseQuestion {
  type: "singleChoice";
  options: ChoiceOption[];
  correctOptionId: string;
}

export interface MultipleChoiceQuestion extends BaseQuestion {
  type: "multipleChoice";
  options: ChoiceOption[];
  correctOptionIds: string[];
}

export interface TrueFalseQuestion extends BaseQuestion {
  type: "trueFalse";
  statement: string;
  correct: boolean;
}

export interface FillBlankQuestion extends BaseQuestion {
  type: "fillBlank";
  template: string;
  acceptedAnswers: string[];
  match?: TextMatchOptions;
}

export interface ClozeBlank {
  id: string;
  acceptedAnswers: string[];
}

export interface MultiClozeQuestion extends BaseQuestion {
  type: "multiCloze";
  template: string;
  blanks: ClozeBlank[];
  match?: TextMatchOptions;
}

export interface WordBankQuestion extends BaseQuestion {
  type: "wordBank";
  tokens: ChoiceOption[];
  correctOrderIds: string[];
}

export interface MatchingPair {
  leftId: string;
  left: string;
  rightId: string;
  right: string;
}

export interface MatchingQuestion extends BaseQuestion {
  type: "matching";
  pairs: MatchingPair[];
}

export interface ReorderTokensQuestion extends BaseQuestion {
  type: "reorderTokens";
  tokens: ChoiceOption[];
  correctOrderIds: string[];
}

export interface DialogueTurn extends ChoiceOption {
  speaker: string;
}

export interface ReorderDialogueQuestion extends BaseQuestion {
  type: "reorderDialogue";
  turns: DialogueTurn[];
  correctOrderIds: string[];
}

export interface CategoryOption extends ChoiceOption {}

export interface CategoryItem extends ChoiceOption {
  categoryId: string;
}

export interface CategorizeQuestion extends BaseQuestion {
  type: "categorize";
  categories: CategoryOption[];
  items: CategoryItem[];
}

export interface TranslationQuestion extends BaseQuestion {
  type: "translation";
  sourceText: string;
  targetLanguage: string;
  referenceAnswer: string;
  rubric: string[];
}

export interface ShortAnswerQuestion extends BaseQuestion {
  type: "shortAnswer";
  referenceAnswer: string;
  requiredIdeas: string[];
  rubric: string[];
}

export interface ErrorCorrectionQuestion extends BaseQuestion {
  type: "errorCorrection";
  incorrectText: string;
  acceptedAnswers: string[];
  match?: TextMatchOptions;
}

export interface SentenceTransformationQuestion extends BaseQuestion {
  type: "sentenceTransformation";
  sourceText: string;
  constraint: string;
  acceptedAnswers: string[];
  match?: TextMatchOptions;
}

export interface DictationQuestion extends BaseQuestion {
  type: "dictation";
  transcript: string;
  acceptedAnswers: string[];
  match?: TextMatchOptions;
}

export interface FreeWritingQuestion extends BaseQuestion {
  type: "freeWriting";
  minWords: number;
  maxWords: number;
  rubric: string[];
}

export interface SpeakingRepeatQuestion extends BaseQuestion {
  type: "speakingRepeat";
  modelText: string;
  rubric: string[];
}

export interface SpeakingRoleplayQuestion extends BaseQuestion {
  type: "speakingRoleplay";
  role: string;
  scenario: string;
  goal: string;
  rubric: string[];
}

export type LessonQuestion =
  | SingleChoiceQuestion
  | MultipleChoiceQuestion
  | TrueFalseQuestion
  | FillBlankQuestion
  | MultiClozeQuestion
  | WordBankQuestion
  | MatchingQuestion
  | ReorderTokensQuestion
  | ReorderDialogueQuestion
  | CategorizeQuestion
  | TranslationQuestion
  | ShortAnswerQuestion
  | ErrorCorrectionQuestion
  | SentenceTransformationQuestion
  | DictationQuestion
  | FreeWritingQuestion
  | SpeakingRepeatQuestion
  | SpeakingRoleplayQuestion;

export type QuestionAnswer = string | boolean | string[] | Record<string, string>;

export interface TheoryBlock {
  id: string;
  kind: "concept" | "grammar" | "pronunciation" | "culture" | "tip";
  title: string;
  body: string;
}

export interface LessonExample {
  id: string;
  source: string;
  translation?: string;
  note?: string;
}

export interface GlossaryEntry {
  term: string;
  meaning: string;
  example?: string;
}

export interface SourceReference {
  id: string;
  kind: "unit" | "document" | "youtube" | "transcript" | "note";
  title: string;
  url?: string;
  excerpt?: string;
}

export interface Lesson {
  schemaVersion: 1;
  id: string;
  unitId: string;
  title: string;
  summary: string;
  targetLanguage: string;
  level: LearningProfile["level"];
  objectives: string[];
  theory: TheoryBlock[];
  examples: LessonExample[];
  glossary: GlossaryEntry[];
  sourceReferences: SourceReference[];
  questions: LessonQuestion[];
  createdAt: string;
}

export interface EvaluationError {
  location: string;
  message: string;
}

export interface RubricScore {
  criterion: string;
  score: number;
  note: string;
}

export interface Evaluation {
  status: EvaluationStatus;
  score: number;
  correctParts: string[];
  errors: EvaluationError[];
  correction: string;
  explanation: string;
  nextHint: string;
  rubricScores?: RubricScore[];
  pronunciationAssessed?: boolean;
}

export interface LocalGradeResult extends Evaluation {
  requiresAi: false;
}

export interface AiGradeRequest {
  requiresAi: true;
  reason: "semantic" | "writing" | "speaking";
}

export type GradeResult = LocalGradeResult | AiGradeRequest;

export interface AttemptRecord {
  questionId: string;
  attemptNumber: number;
  status: EvaluationStatus;
  score: number;
  firstTry: boolean;
  answeredAt: string;
}

export interface LessonProgressSnapshot {
  lessonId: string;
  completedQuestionIds: string[];
  attemptsByQuestion: Record<string, number>;
  firstTryCorrect: number;
  totalQuestions: number;
  masteryPercent: number;
  updatedAt: string;
}

export interface SpeakingSubmission {
  transcript?: string;
  durationMs: number;
  wordsPerMinute?: number;
  pauseCount?: number;
  pronunciationAvailable: boolean;
  audio?: Blob;
}
