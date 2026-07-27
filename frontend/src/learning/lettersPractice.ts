import {
  DEFAULT_LETTERS_PRACTICE_CHARACTERS,
  lettersPracticeFamilyKey,
  normalizeLettersPracticeCharacterCount,
  unicodeLabel,
  type LetterProgressStatus,
  type LettersScript,
} from "./letters";
import type {
  AudioMatchingQuestion,
  CharacterTracingQuestion,
  ChoiceOption,
  GlossaryEntry,
  MatchingQuestion,
  PlayableLesson,
  PlayableQuestion,
  PlayableQuestionAlternate,
  SingleChoiceQuestion,
  ListenSelectQuestion,
} from "./types";

export interface LettersCharacterMetadata {
  displayLabel?: string;
  reading?: string;
  meaning?: string;
}

export interface LettersPracticeSession {
  lesson: PlayableLesson;
  targetCharacters: string[];
  questionIdsByCharacter: Record<string, string[]>;
}

interface BuildLettersPracticeOptions {
  collectionId: string;
  language: string;
  sourceLanguage: string;
  level: PlayableLesson["level"];
  script: LettersScript;
  scriptLabel: string;
  characters: string[];
  metadata: ReadonlyMap<string, LettersCharacterMetadata>;
  progress: Readonly<Record<string, LetterProgressStatus>>;
  requireStrokeOrder: boolean;
  characterCount?: number;
  sessionId?: string;
  createdAt?: string;
}

const MATCHING_GROUP_SIZE = 5;

function characterKey(character: string): string {
  return [...character]
    .map((part) => part.codePointAt(0)?.toString(16) ?? "0")
    .join("-");
}

function progressPriority(status?: LetterProgressStatus): number {
  if (status === "practicing") return 0;
  if (status === undefined) return 1;
  return 2;
}

export function selectLettersPracticeCharacters(
  characters: string[],
  progress: Readonly<Record<string, LetterProgressStatus>>,
  characterCount = DEFAULT_LETTERS_PRACTICE_CHARACTERS,
): string[] {
  const targetCount = Math.min(
    characters.length,
    normalizeLettersPracticeCharacterCount(characterCount),
  );
  const ordered = characters
    .map((character, index) => ({ character, index, priority: progressPriority(progress[character]) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const selected: string[] = [];
  const deferred: string[] = [];
  const selectedFamilies = new Set<string>();

  ordered.forEach(({ character }) => {
    const family = lettersPracticeFamilyKey(character);
    if (selected.length < targetCount && !selectedFamilies.has(family)) {
      selected.push(character);
      selectedFamilies.add(family);
    } else {
      deferred.push(character);
    }
  });

  for (const character of deferred) {
    if (selected.length >= targetCount) break;
    selected.push(character);
  }
  return selected;
}

export function lettersPracticeExerciseCount(characterCount: number): number {
  if (!Number.isFinite(characterCount) || characterCount <= 0) return 0;
  const normalizedCount = normalizeLettersPracticeCharacterCount(characterCount);
  return normalizedCount * 4 + Math.ceil(normalizedCount / MATCHING_GROUP_SIZE);
}

function practiceChoicePool(characters: string[], targets: string[]): string[] {
  const selected = new Set(targets);
  const usedFamilies = new Set(targets.map(lettersPracticeFamilyKey));
  const pool = [...targets];

  characters.forEach((character) => {
    if (selected.has(character)) return;
    const family = lettersPracticeFamilyKey(character);
    if (usedFamilies.has(family)) return;
    usedFamilies.add(family);
    pool.push(character);
  });
  return pool;
}

function choiceOptions(target: string, characters: string[]): ChoiceOption[] {
  const targetIndex = Math.max(0, characters.indexOf(target));
  const options = [target];
  for (let offset = 1; options.length < Math.min(4, characters.length); offset += 1) {
    const candidate = characters[(targetIndex + offset) % characters.length];
    if (!options.includes(candidate)) options.push(candidate);
  }
  const shift = options.length > 1 ? targetIndex % options.length : 0;
  return [...options.slice(shift), ...options.slice(0, shift)].map((character) => ({
    id: `character-${characterKey(character)}`,
    label: character,
  }));
}

function baseQuestion(id: string, type: PlayableQuestion["type"], prompt: string) {
  return {
    id,
    type,
    prompt,
    evaluationMode: "local" as const,
    explanation: "This Letters exercise is checked locally and missed questions return until mastered.",
    hint: "Compare the character shape, sound, and reading before trying again.",
  };
}

function visualChoiceQuestion(
  id: string,
  target: string,
  characters: string[],
): SingleChoiceQuestion {
  const options = choiceOptions(target, characters);
  return {
    ...baseQuestion(id, "singleChoice", "Select the matching character."),
    type: "singleChoice",
    targetPrompt: target,
    glossaryTargets: options.map((option) => option.label),
    options,
    correctOptionId: `character-${characterKey(target)}`,
  };
}

function descriptorChoiceQuestion(
  id: string,
  target: string,
  characters: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): SingleChoiceQuestion {
  const characterMetadata = metadata.get(target);
  const descriptor = characterMetadata?.displayLabel
    ?? characterMetadata?.reading
    ?? characterMetadata?.meaning;
  if (!descriptor) return visualChoiceQuestion(id, target, characters);
  const options = choiceOptions(target, characters);
  return {
    ...baseQuestion(
      id,
      "singleChoice",
      characterMetadata?.displayLabel
        ? `Which character is "${descriptor}"?`
        : characterMetadata?.reading
        ? `Which character is read "${descriptor}"?`
        : `Which character means "${descriptor}"?`,
    ),
    type: "singleChoice",
    glossaryTargets: options.map((option) => option.label),
    options,
    correctOptionId: `character-${characterKey(target)}`,
  };
}

function listeningQuestion(
  id: string,
  target: string,
  characters: string[],
): ListenSelectQuestion {
  const options = choiceOptions(target, characters);
  return {
    ...baseQuestion(id, "listenSelect", "Listen and select the character you hear."),
    type: "listenSelect",
    audioText: target,
    glossaryTargets: options.map((option) => option.label),
    options,
    correctOptionId: `character-${characterKey(target)}`,
  };
}

function tracingQuestion(
  id: string,
  target: string,
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
  requireStrokeOrder: boolean,
): CharacterTracingQuestion {
  const characterMetadata = metadata.get(target);
  return {
    ...baseQuestion(id, "characterTracing", "Trace the character."),
    type: "characterTracing",
    character: target,
    reading: characterMetadata?.displayLabel ?? characterMetadata?.reading,
    meaning: characterMetadata?.meaning,
    requireStrokeOrder,
    glossaryTargets: [target],
  };
}

function matchingDescriptor(
  character: string,
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
  used: Set<string>,
): string {
  const characterMetadata = metadata.get(character);
  const preferred = characterMetadata?.displayLabel
    ?? characterMetadata?.reading
    ?? characterMetadata?.meaning
    ?? unicodeLabel(character);
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  const unique = `${preferred} - ${unicodeLabel(character)}`;
  used.add(unique);
  return unique;
}

function matchingQuestions(
  id: string,
  targets: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): { primary: AudioMatchingQuestion; alternate: MatchingQuestion } {
  const usedDescriptors = new Set<string>();
  const primary: AudioMatchingQuestion = {
    ...baseQuestion(id, "audioMatching", "Match each sound to its character."),
    type: "audioMatching",
    glossaryTargets: [...targets],
    pairs: targets.map((character) => ({
      audioId: `audio-${characterKey(character)}`,
      audioText: character,
      matchId: `match-${characterKey(character)}`,
      label: character,
    })),
  };
  const alternate: MatchingQuestion = {
    ...baseQuestion(`${id}-alternate`, "matching", "Match each reading or code to its character."),
    type: "matching",
    glossaryTargets: [...targets],
    pairs: targets.map((character) => ({
      leftId: `descriptor-${characterKey(character)}`,
      left: matchingDescriptor(character, metadata, usedDescriptors),
      rightId: `match-${characterKey(character)}`,
      right: character,
    })),
  };
  return { primary, alternate };
}

function glossaryFor(
  targets: string[],
  metadata: ReadonlyMap<string, LettersCharacterMetadata>,
): GlossaryEntry[] {
  return targets.map((character) => {
    const characterMetadata = metadata.get(character);
    return {
      term: character,
      meaning: characterMetadata?.meaning ?? `${unicodeLabel(character)} character`,
      ...(characterMetadata?.reading
        ? { pronunciation: { romanized: characterMetadata.reading } }
        : {}),
    };
  });
}

export function buildLettersPracticeSession({
  collectionId,
  language,
  sourceLanguage,
  level,
  script,
  scriptLabel,
  characters,
  metadata,
  progress,
  requireStrokeOrder,
  characterCount = DEFAULT_LETTERS_PRACTICE_CHARACTERS,
  sessionId = `letters-${Date.now()}`,
  createdAt = new Date().toISOString(),
}: BuildLettersPracticeOptions): LettersPracticeSession {
  const targets = selectLettersPracticeCharacters(characters, progress, characterCount);
  if (!targets.length) throw new Error("No characters are available for this Letters practice.");
  const choicePool = practiceChoicePool(characters, targets);

  const questions: PlayableQuestion[] = [];
  const questionAlternates: PlayableQuestionAlternate[] = [];
  const questionIdsByCharacter = Object.fromEntries(targets.map((character) => [character, [] as string[]]));
  let questionNumber = 0;

  function register(question: PlayableQuestion, relatedCharacters: string[]) {
    questions.push(question);
    relatedCharacters.forEach((character) => questionIdsByCharacter[character]?.push(question.id));
  }

  targets.forEach((target) => {
    const targetKey = characterKey(target);
    const tracingId = `${sessionId}-q${++questionNumber}-${targetKey}-trace`;
    register(tracingQuestion(tracingId, target, metadata, requireStrokeOrder), [target]);

    const listeningId = `${sessionId}-q${++questionNumber}-${targetKey}-listen`;
    const listening = listeningQuestion(listeningId, target, choicePool);
    register(listening, [target]);
    questionAlternates.push({
      questionId: listening.id,
      question: visualChoiceQuestion(`${listeningId}-alternate`, target, choicePool),
    });

    const visualId = `${sessionId}-q${++questionNumber}-${targetKey}-visual`;
    register(visualChoiceQuestion(visualId, target, choicePool), [target]);

    const descriptorId = `${sessionId}-q${++questionNumber}-${targetKey}-descriptor`;
    register(descriptorChoiceQuestion(descriptorId, target, choicePool, metadata), [target]);
  });

  for (let index = 0; index < targets.length; index += MATCHING_GROUP_SIZE) {
    const group = targets.slice(index, index + MATCHING_GROUP_SIZE);
    const matchingId = `${sessionId}-q${++questionNumber}-matching-${Math.floor(index / MATCHING_GROUP_SIZE) + 1}`;
    const matching = matchingQuestions(matchingId, group, metadata);
    register(matching.primary, group);
    questionAlternates.push({ questionId: matching.primary.id, question: matching.alternate });
  }

  return {
    targetCharacters: targets,
    questionIdsByCharacter,
    lesson: {
      schemaVersion: 7,
      id: sessionId,
      unitId: `letters:${collectionId}:${script}`,
      title: `${scriptLabel} practice`,
      summary: `${questions.length} local exercises for ${targets.length} characters across tracing, recognition, listening, and matching.`,
      targetLanguage: language,
      sourceLanguage,
      level,
      objectives: [`Recognize and write the selected ${scriptLabel} characters.`],
      theory: [{
        id: `${sessionId}-guide`,
        kind: "pronunciation",
        title: `${scriptLabel} focus`,
        body: "Listen, compare the character forms, and follow the highlighted stroke direction. Missed exercises return until correct.",
      }],
      examples: targets.map((character) => ({
        id: `${sessionId}-example-${characterKey(character)}`,
        source: character,
        translation: metadata.get(character)?.displayLabel
          ?? metadata.get(character)?.reading
          ?? metadata.get(character)?.meaning,
      })),
      glossary: glossaryFor(targets, metadata),
      sourceReferences: [],
      questions,
      questionAlternates,
      createdAt,
    },
  };
}
